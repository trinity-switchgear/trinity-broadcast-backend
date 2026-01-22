require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const XLSX = require("xlsx");
const Pino = require("pino");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const qrcode = require("qrcode-terminal");
const rateLimit = require("express-rate-limit");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();

app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

/* ====== CORS ====== */
const allowedOrigins = [
  "http://localhost:3000",
  "https://trinityswitchgear.vercel.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "ngrok-skip-browser-warning",
    ],
  }),
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

/* ====== JWT AUTH MIDDLEWARE ====== */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ error: "Invalid token" });
  }
}

/* ====== RATE LIMIT LOGIN ====== */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

/* ====== ADMIN LOGIN ====== */
app.post("/admin/login", loginLimiter, (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS
  ) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, {
      expiresIn: "12h",
    });
    return res.json({ success: true, token, name: "Admin" });
  }

  return res
    .status(401)
    .json({ success: false, message: "Invalid credentials" });
});

/* ====== MULTER ====== */
const upload = multer({ dest: "uploads/" });

let sock;
let isConnected = false;

/* ====== READ EXCEL ====== */
function cleanNumber(num) {
  return String(num).replace(/\D/g, "");
}

function getUsersFromExcel(type) {
  const workbook = XLSX.readFile("contacts.xlsx");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  let numbers = [];

  data.forEach((row) => {
    if ((type === "All" || type === "Contractors") && row["Contractors"])
      numbers.push(row["Contractors"]);

    if (
      (type === "All" || type === "Individual Customers") &&
      row["Individual Customers"]
    )
      numbers.push(row["Individual Customers"]);

    if ((type === "All" || type === "Retailers") && row["Retailers"])
      numbers.push(row["Retailers"]);
  });

  return numbers
    .map(cleanNumber)
    .filter((n) => n.length === 12)
    .map((n) => `${n}@s.whatsapp.net`);
}

/* ====== COUNT (PROTECTED) ====== */
app.get("/count", authMiddleware, (req, res) => {
  const users = getUsersFromExcel(req.query.target);
  res.json({ count: users.length });
});

/* ====== START WHATSAPP BOT ====== */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  sock = makeWASocket({
    auth: state,
    logger: Pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "open") {
      console.log("✅ WhatsApp Connected");
      isConnected = true;
    }

    if (connection === "close") {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });
}

startBot();

/* ====== BROADCAST (PROTECTED) ====== */
let currentBroadcast = null;

app.post(
  "/broadcast",
  authMiddleware,
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "pdf", maxCount: 1 },
  ]),
  async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const { message, target, imageCaption, pdfCaption } = req.body;
    const image = req.files?.image?.[0];
    const pdf = req.files?.pdf?.[0];

    if (!isConnected || !sock) {
      res.write(
        `data: ${JSON.stringify({ done: true, error: "WhatsApp not connected" })}\n\n`,
      );
      return res.end();
    }

    const users = getUsersFromExcel(target);
    const total = users.length;
    if (!total) {
      res.write(
        `data: ${JSON.stringify({ done: true, error: "No numbers found" })}\n\n`,
      );
      return res.end();
    }

    let sent = 0;
    let paused = false;
    let stopped = false;

    currentBroadcast = {
      pause: () => (paused = true),
      resume: () => (paused = false),
      stop: () => (stopped = true),
    };

    for (const jid of users) {
      if (stopped) break;
      while (paused) await new Promise((r) => setTimeout(r, 500));

      try {
        if (message) await sock.sendMessage(jid, { text: message });

        if (image)
          await sock.sendMessage(jid, {
            image: fs.readFileSync(image.path),
            caption: imageCaption || "",
          });

        if (pdf)
          await sock.sendMessage(jid, {
            document: fs.readFileSync(pdf.path),
            mimetype: "application/pdf",
            fileName: pdf.originalname,
            caption: pdfCaption || "",
          });

        sent++;
        res.write(
          `data: ${JSON.stringify({ sent, total, jid, success: true })}\n\n`,
        );
      } catch {
        sent++;
        res.write(
          `data: ${JSON.stringify({ sent, total, jid, success: false })}\n\n`,
        );
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    res.write(`data: ${JSON.stringify({ done: true, sent, total })}\n\n`);
    res.end();
    currentBroadcast = null;
  },
);

/* ====== CONTROL ENDPOINTS ====== */
app.post("/broadcast/pause", authMiddleware, (req, res) => {
  if (currentBroadcast) currentBroadcast.pause();
  res.json({ status: "paused" });
});

app.post("/broadcast/resume", authMiddleware, (req, res) => {
  if (currentBroadcast) currentBroadcast.resume();
  res.json({ status: "resumed" });
});

app.post("/broadcast/stop", authMiddleware, (req, res) => {
  if (currentBroadcast) currentBroadcast.stop();
  res.json({ status: "stopped" });
});

/* ====== START SERVER ====== */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log("🌐 Backend running on port", PORT);
});
