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
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();

// ====== MIDDLEWARES ======
app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

// ====== CORS ======
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

// ====== JWT AUTH ======
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

// ====== LOGIN RATE LIMIT ======
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

// ====== ADMIN LOGIN ======
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

// ====== MULTER ======
const upload = multer({ dest: "uploads/" });

// ====== EXCEL / CONTACTS ======
function cleanNumber(num) {
  return String(num).replace(/\D/g, "");
}
function getUsersFromExcel(type) {
  if (!fs.existsSync("contacts.xlsx")) return [];
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

// ====== COUNT ENDPOINT ======
app.get("/count", authMiddleware, (req, res) => {
  const users = getUsersFromExcel(req.query.target);
  res.json({ count: users.length });
});

// ====== WHATSAPP BOT ======
let sock;
let isConnected = false;

// Users / state files
const USERS_FILE = "./users.json";
const GREET_FILE = "./greetings.json";
const ADMINS = ["917021217553@s.whatsapp.net", "222634629456125@lid"];
const GREETING_COOLDOWN = 8 * 60 * 60 * 1000;

let users = fs.existsSync(USERS_FILE)
  ? JSON.parse(fs.readFileSync(USERS_FILE))
  : [];
let greetingTimestamps = fs.existsSync(GREET_FILE)
  ? JSON.parse(fs.readFileSync(GREET_FILE))
  : {};

const processedMessages = new Set();
const userState = {};
const MAX_RETRIES = 2;

// ====== HELPER FUNCTIONS ======
async function isJidAlive(sock, jid) {
  try {
    const [result] = await sock.onWhatsApp(jid);
    return result?.exists === true;
  } catch {
    return false;
  }
}
function removeDeadJid(jid) {
  users = users.filter((u) => u !== jid);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  console.log("🗑️ Removed dead JID:", jid);
}
async function sendWithRetry(sock, jid, text) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sock.sendMessage(jid, { text });
      return true;
    } catch (err) {
      console.log(`⚠️ Retry ${attempt} failed for:`, jid);
      if (attempt === MAX_RETRIES) {
        removeDeadJid(jid);
        return false;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
async function dailyJidHealthCheck(sock) {
  console.log("🩺 Running daily JID health check...");
  for (const user of [...users]) {
    const alive = await isJidAlive(sock, user);
    if (!alive) removeDeadJid(user);
  }
  console.log("✅ Daily JID health check completed");
}
function scheduleDailyHealthCheck(sock) {
  const now = new Date();
  const nextCheck = new Date();
  nextCheck.setHours(2, 0, 0, 0);
  if (now > nextCheck) nextCheck.setDate(nextCheck.getDate() + 1);
  const delay = nextCheck - now;
  setTimeout(async function run() {
    await dailyJidHealthCheck(sock);
    setInterval(
      async () => await dailyJidHealthCheck(sock),
      24 * 60 * 60 * 1000,
    );
  }, delay);
}

// ====== BROADCAST CONTROLS ======
let currentBroadcast = null;

// Protected broadcast endpoint
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

// ====== START BOT ======
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  sock = makeWASocket({
    auth: state,
    logger: Pino({ level: "fatal" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "open") {
      console.log("✅ WhatsApp connected successfully");
      isConnected = true;
      scheduleDailyHealthCheck(sock);
    }

    if (connection === "close") {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const msg = messages[0];
    if (!msg?.key?.id || !msg.message) return;

    const jid = msg.key.remoteJid || msg.key.participant;

    // Deduplicate
    if (processedMessages.has(msg.key.id)) return;
    processedMessages.add(msg.key.id);
    setTimeout(() => processedMessages.delete(msg.key.id), 60_000);

    const isPrivateChat =
      jid.endsWith("@s.whatsapp.net") ||
      jid.endsWith("@c.us") ||
      jid.endsWith("@lid");
    const isAdmin = ADMINS.includes(jid);

    // Parse message text
    const message = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      ""
    )
      .toLowerCase()
      .trim();

    // Save new users
    if (isPrivateChat && !isAdmin && !msg.key.fromMe && !users.includes(jid)) {
      users.push(jid);
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      console.log("✅ New customer saved:", jid);
    }

    // Ignore own messages unless admin broadcast
    if (msg.key.fromMe && !message.startsWith("/broadcast")) return;

    await new Promise((r) => setTimeout(r, 1500));

    // ===== GREETING =====
    if (isPrivateChat && !msg.key.fromMe) {
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        "";

      const message = text.toLowerCase().trim();

      // Skip greeting if user sent a menu starter message
      const menuStarters = ["hi", "hii", "hiii", "hello", "menu", "start"];
      if (menuStarters.includes(message)) {
        // User will go directly to menu, so don't send greeting
        const now = Date.now();
        greetingTimestamps[jid] = now;
        fs.writeFileSync(
          GREET_FILE,
          JSON.stringify(greetingTimestamps, null, 2),
        );
      } else {
        const now = Date.now();
        if (
          !greetingTimestamps[jid] ||
          now - greetingTimestamps[jid] >= GREETING_COOLDOWN
        ) {
          greetingTimestamps[jid] = now;
          fs.writeFileSync(
            GREET_FILE,
            JSON.stringify(greetingTimestamps, null, 2),
          );

          await sock.sendMessage(jid, {
            text: `Hello 👋 
Welcome to *Trinity Electric Syndicate* ⚡
📍 Mumbai

We are suppliers of: 
🔷 Switchgear
🔷 Cables & Wires
🔷 Panels & Electrical Accessories

Type *MENU / START / HI* to see options.`,
          });
        }
      }
    }

    // ===== ADMIN BROADCAST =====
    if (isAdmin && message.startsWith("/broadcast")) {
      const broadcastText = text.replace("/broadcast", "").trim();
      if (!broadcastText) {
        return sock.sendMessage(jid, {
          text: "❌ Usage:\n/broadcast Your message here",
        });
      }

      await sock.sendMessage(jid, {
        text: `📢 Broadcasting to ${users.length} users...`,
      });

      for (const user of [...users]) {
        if (user === jid) continue;
        const alive = await isJidAlive(sock, user);
        if (!alive) removeDeadJid(user);
        else await sendWithRetry(sock, user, broadcastText);
        await new Promise((r) => setTimeout(r, 2500));
      }

      return sock.sendMessage(jid, { text: "✅ Broadcast completed" });
    }

    // ===== MENU LOGIC =====
    if (!userState[jid])
      userState[jid] = { step: null, menuActive: false, busy: false };
    if (["hi", "hii", "hiii", "hello", "menu", "start"].includes(message)) {
      userState[jid] = { step: "MAIN_MENU", menuActive: true };
      return sock.sendMessage(jid, {
        text: `*Thanks for choosing us*

Please choose a menu reply with a number:

1️⃣ Product Catalogue
2️⃣ Get Price / Quotation
3️⃣ Panel Accessories we provide
4️⃣ Brands We Deal In
5️⃣ Store Address & Timing
6️⃣ Talk to a Human`,
      });
    }

    if (!userState[jid].menuActive) return;
    const validInputs = ["0", "1", "2", "3", "4", "5", "6"];
    if (!validInputs.includes(message)) {
      userState[jid].menuActive = false;
      userState[jid].step = null;
      return;
    }

    if (userState[jid].step === "MAIN_MENU") {
      switch (message) {
        case "1":
          userState[jid].step = "PRODUCTS"; // ✅ VERY IMPORTANT
          return sock.sendMessage(jid, {
            text: `📦 *Product Catalogue*

Reply with a number:
1️⃣ Switchgear & MCB
2️⃣ Control Panel Accessories
3️⃣ Industrial Cables
4️⃣ Earthing & Lighting
5️⃣ Timers & Smart Devices
6️⃣ PVC Conduit Pipes
◀️ Reply *MENU or HI* to open menu again.`,
          });

        case "2":
          userState[jid].menuActive = false;
          userState[jid].step = null;
          return sock.sendMessage(jid, {
            text: `💰 *Get Price / Quotation*

Please send:
• Product name
• Quantity
• Brand (if any)

Our team will reply shortly.

Reply *MENU or HI* to open menu again.`,
          });
        case "3":
          userState[jid].menuActive = false;
          userState[jid].step = null;
          return sock.sendMessage(jid, {
            text: `🧰 *Panel Accessories we provide*

✔ Indicator Lamps
✔ Push Buttons
✔ Selector Switches
✔ SMPS
✔ Contactors & Relays
✔ Cooling Fans & Filters

Reply *MENU or HI* to open menu again.`,
          });
        case "4":
          userState[jid].menuActive = false;
          userState[jid].step = null;
          return sock.sendMessage(jid, {
            text: `🏷️ *Brands We Deal In*

✔ SCHNEIDER
✔ L&T
✔ SIEMENS
✔ DANFOSS
✔ Havells
✔ TEKNIC
✔ POLYCAB
✔ FINOLEX
✔ SWITZER
✔ INDFOS
✔ WIKA
✔ APAR

Reply *MENU or HI* to open menu again.`,
          });
        case "5":
          userState[jid].menuActive = false;
          userState[jid].step = null;
          return sock.sendMessage(jid, {
            text: `📍 *Store Address & Timing*

Trinity Electric Syndicate
154, Shamaldas Gandhi Marg, Kalbadevi Road, 
Mumbai – 400002

🕘 Mon–Sat: 10:00 AM – 7:00 PM
Sunday: Closed

Reply *MENU or HI* to open menu again.`,
          });
        case "6":
          userState[jid].menuActive = false;
          userState[jid].step = null;
          return sock.sendMessage(jid, {
            text: `👨‍💼 *Talk to a Human*

Please type your query.
Our executive will connect shortly.


Reply *MENU or HI* to open menu again.`,
          });
      }
    }

    if (userState[jid].step === "PRODUCTS") {
      switch (message) {
        case "1": {
          const files = [
            {
              path: "catalogs/legrant_switchgear_mcb.pdf",
              name: "Legrant_Switchgear.pdf",
            },
            {
              path: "catalogs/hager_switchgear_panel.pdf",
              name: "Hager_Switchgear.pdf",
            },
            {
              path: "catalogs/l&t_switchgear.pdf",
              name: "L&T_Switchgear.pdf",
            },
            {
              path: "catalogs/siemens_switchgear.pdf",
              name: "SIEMENS_Switchgear.pdf",
            },
          ];

          userState[jid].busy = true; // 🔒 LOCK

          await sock.sendMessage(jid, {
            text: `📄 Please wait, I am sending ${files.length} PDF(s)...`,
          });

          for (const file of files) {
            const filePath = path.join(__dirname, file.path);
            await sock.sendMessage(jid, {
              document: fs.readFileSync(filePath),
              mimetype: "application/pdf",
              fileName: file.name,
            });
            await new Promise((r) => setTimeout(r, 1500)); // small delay
          }

          userState[jid].busy = false; // 🔓 UNLOCK

          return;
        }

        case "2": {
          const files = [
            {
              path: "catalogs/l&t_control_panel.pdf",
              name: "L&T_Control_Panel.pdf",
            },
            {
              path: "catalogs/hager_switchgear_panel.pdf",
              name: "Hager_Control_Panel_Accessories.pdf",
            },
          ];

          userState[jid].busy = true; // 🔒 LOCK

          await sock.sendMessage(jid, {
            text: `📄 Please wait, I am sending ${files.length} PDF(s)...`,
          });

          for (const file of files) {
            const filePath = path.join(__dirname, file.path);
            await sock.sendMessage(jid, {
              document: fs.readFileSync(filePath),
              mimetype: "application/pdf",
              fileName: file.name,
            });
            await new Promise((r) => setTimeout(r, 1500)); // small delay
          }

          userState[jid].busy = false; // 🔓 UNLOCK

          return;
        }

        case "3":
          return sock.sendMessage(jid, {
            text: `🔌 *Industrial Cables*

    ✔ Copper / Aluminium
    ✔ Armoured / Unarmoured
    ✔ Control & Power Cables

    We will Quote as per requirement as there are frequent changes in Raw material pricing.


    Reply *MENU or HI* to open menu again.`,
          });
        case "4":
          return sock.sendMessage(jid, {
            text: `💡 *Earthing & Lighting*

    ✔ Earthing Electrodes
    ✔ GI / Copper Strips
    ✔ Industrial Lights

    Reply *MENU or HI* to open menu again.`,
          });
        case "5": {
          const files = [
            {
              path: "catalogs/agri_smart_devices.pdf",
              name: "AGRI_Smart_Devices.pdf",
            },
            {
              path: "catalogs/ohm_assisstant_brochure.pdf",
              name: "OHM_Assistant_Brochure.pdf",
            },
            {
              path: "catalogs/switzer_smart_switches.pdf",
              name: "Switzer_Pressure_Switches.pdf",
            },
            {
              path: "catalogs/eapl_smart_devices.pdf",
              name: "EAPL_Smart_Devices.pdf",
            },
            {
              path: "catalogs/schneider_smart_devices.pdf",
              name: "Schneider_Smart_Devices.pdf",
            },
          ];

          userState[jid].busy = true; // 🔒 LOCK

          await sock.sendMessage(jid, {
            text: `📄 Please wait, I am sending ${files.length} PDF(s)...`,
          });

          for (const file of files) {
            const filePath = path.join(__dirname, file.path);
            await sock.sendMessage(jid, {
              document: fs.readFileSync(filePath),
              mimetype: "application/pdf",
              fileName: file.name,
            });
            await new Promise((r) => setTimeout(r, 1500)); // delay between sends
          }

          userState[jid].busy = false; // 🔓 UNLOCK

          return;
        }

        case "6": {
          const files = [
            {
              path: "catalogs/blp_pipes.pdf",
              name: "BLP_PVC_Conduit_Pipes.pdf",
            },
            {
              path: "catalogs/precision_pipes.pdf",
              name: "Precision_PVC_Conduit_Pipes.pdf",
            },
          ];

          userState[jid].busy = true; // 🔒 LOCK

          await sock.sendMessage(jid, {
            text: `📄 Please wait, I am sending ${files.length} PDF(s)...`,
          });

          for (const file of files) {
            const filePath = path.join(__dirname, file.path);
            await sock.sendMessage(jid, {
              document: fs.readFileSync(filePath),
              mimetype: "application/pdf",
              fileName: file.name,
            });
            await new Promise((r) => setTimeout(r, 1500));
          }

          userState[jid].busy = false; // 🔓 UNLOCK

          return;
        }

        case "0":
          userState[jid].step = "MAIN_MENU";
          return sock.sendMessage(jid, {
            text: "⬅️ Back to Main Menu. Reply *MENU or HI*",
          });
      }
    }
    // ... (You can keep your detailed menu and PDF sending logic here)
  });
}

// ====== START SERVER ======
startBot();
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("🌐 Backend running on port", PORT));
