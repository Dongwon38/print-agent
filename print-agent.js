const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const axios = require("axios");
const fs = require("fs").promises;
const escpos = require("escpos");
escpos.Network = require("escpos-network");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const API_URL = process.env.API_URL || "https://nightowlcafe.ca/wp-json/custom/v1";
const PORT = process.env.PORT || 3000;
const PRINTER1_IP = process.env.PRINTER1_IP || "192.168.1.100";
const PRINTER2_IP = process.env.PRINTER2_IP || "192.168.1.101";
const TOKEN_FILE = "./jwt_token.txt";

let JWT_TOKEN = null;
let pollingInterval = null;

const printer1 = new escpos.Printer(new escpos.Network(PRINTER1_IP));
const printer2 = new escpos.Printer(new escpos.Network(PRINTER2_IP));

// 로그 함수
function log(message) {
  console.log(message);
  io.emit("log", message);
}

// 상태 업데이트 함수
function updateStatus(status) {
  io.emit("status", status);
}

// Express 설정
app.use(express.json());
app.use(express.static(__dirname));

// 루트 경로
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// 로그인 엔드포인트
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const response = await axios.post(
      `${API_URL}/login`,
      { username, password },
      { headers: { "Content-Type": "application/json" }, withCredentials: true }
    );
    JWT_TOKEN = response.data.token;
    await fs.writeFile(TOKEN_FILE, JWT_TOKEN);
    log("Login successful");
    res.json({ status: "success", message: "Logged in" });
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    log(`Login error: ${errorMsg}`);
    res.status(401).json({ status: "error", message: "Login failed" });
  }
});

// 서버 시작 엔드포인트
app.get("/start", (req, res) => {
  if (!JWT_TOKEN) {
    log("Please login first");
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }
  if (!pollingInterval) {
    log("Starting server...");
    pollOrders();
    pollingInterval = setInterval(pollOrders, 5000);
    updateStatus("Running");
    res.json({ status: "started" });
  } else {
    log("Server already running.");
    res.json({ status: "already_running" });
  }
});

// 서버 중지 엔드포인트
app.get("/stop", (req, res) => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    log("Server stopped.");
    updateStatus("Stopped");
    res.json({ status: "stopped" });
  } else {
    log("Server not running.");
    res.json({ status: "not_running" });
  }
});

// 주문 출력 함수
async function printOrder(order) {
  let cart;
  try {
    cart = JSON.parse(order.cart);
  } catch (e) {
    log(`Error parsing cart for order #${order.order_number}: ${e.message}`);
    return;
  }

  const printers = [printer1, printer2];
  for (const printer of printers) {
    try {
      log(`Printing on ${printer.device.host || "unknown printer"}...`);
      await new Promise((resolve, reject) => {
        printer.device.open((err) => {
          if (err) {
            reject(new Error(`Failed to connect to printer: ${err.message}`));
          } else {
            resolve();
          }
        });
      });

      printer.font("a").align("ct");
      printer
        .text(`ORDER #${order.order_number}`)
        .text("----------------------------------------")
        .align("lt")
        .text(`Customer: ${order.customer_name}`)
        .text(`Phone: ${order.customer_phone}`)
        .text(`Email: ${order.customer_email || "N/A"}`)
        .text(`Order Time: ${order.created_at}`)
        .text(`Pickup Time: ${order.due_at}`)
        .text(`Order Type: ${order.order_type}`)
        .text("----------------------------------------")
        .text("Items:");
      cart.forEach((item, index) => {
        const itemLine = `${index + 1}. ${item.name}`.padEnd(35) + `$${Number(item.subtotal).toFixed(2)}`;
        printer.text(itemLine);
        const basePriceLine = "   Base Price:".padEnd(35) + `$${Number(item.basePrice).toFixed(2)}`;
        printer.text(basePriceLine);
        item.options.forEach((option) => {
          option.choices.forEach((choice) => {
            const optionLine = `   - ${option.category}: ${choice.name}`.padEnd(35) + `$${Number(choice.extraPrice).toFixed(2)}`;
            printer.text(optionLine);
          });
        });
      });
      printer
        .text("----------------------------------------")
        .text(`Subtotal:`.padEnd(35) + `$${Number(order.subtotal).toFixed(2)}`)
        .text(`GST (5%):`.padEnd(35) + `$${Number(order.gst).toFixed(2)}`)
        .text(`PST:`.padEnd(35) + `$${Number(order.pst).toFixed(2)}`)
        .text(`Bag Fee:`.padEnd(35) + `$${Number(order.bag_fee).toFixed(2)}`)
        .text(`Deposit Fee:`.padEnd(35) + `$${Number(order.deposit_fee).toFixed(2)}`)
        .text(`Tip:`.padEnd(35) + `$${Number(order.tip).toFixed(2)}`)
        .text(`Total:`.padEnd(35) + `$${Number(order.total).toFixed(2)}`)
        .text("----------------------------------------")
        .align("ct")
        .text("Thank you for your order!")
        .feed(4)
        .cut();

      await new Promise((resolve) => printer.close(() => resolve()));
      log(`Printed order #${order.order_number} on ${printer.device.host || "unknown printer"}`);

      await axios.post(
        `${API_URL}/update-print-status`,
        { order_id: order.id, print_status: "printed" },
        { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
      );
      log(`Marked order #${order.id} as printed`);
    } catch (error) {
      log(`Print error for order #${order.order_number}: ${error.message}`);
    }
  }
}

// 주문 폴링 함수
async function pollOrders() {
  if (!JWT_TOKEN) {
    log("No token available, please login first.");
    io.emit("relogin", "Session expired, please re-login.");
    return;
  }

  try {
    const response = await axios.get(`${API_URL}/pending-orders`, {
      headers: { Cookie: `jwt_token=${JWT_TOKEN}` },
    });
    const orders = response.data;
    const time = new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" });

    if (orders.length > 0) {
      log(`Found ${orders.length} new orders`);
      for (const order of orders) {
        if (!order.print_status) {
          log(`Order #${order.order_number} detected, printing...`);
          await printOrder(order);
        } else {
          log(`Order #${order.order_number} already printed`);
        }
      }
    } else {
      log(`${time}: No new order.`);
    }
  } catch (error) {
    const status = error.response?.status;
    log(`Polling error: ${status || error.message}`);
    if (status === 401 || status === 403) {
      log("Token expired or invalid, please re-login.");
      JWT_TOKEN = null;
      clearInterval(pollingInterval);
      pollingInterval = null;
      updateStatus("Stopped");
      io.emit("relogin", "Session expired, please re-login.");
    }
    io.emit("error", "Failed to fetch orders");
  }
}

// 서버 시작 시 토큰 로드
async function init() {
  try {
    if (await fs.access(TOKEN_FILE).then(() => true).catch(() => false)) {
      JWT_TOKEN = await fs.readFile(TOKEN_FILE, "utf8");
      log("Loaded saved token");
    }
  } catch (error) {
    log(`Error loading token: ${error.message}`);
  }
}

init().then(() => {
  server.listen(PORT, () => {
    log(`Server running on http://localhost:${PORT}`);
    updateStatus(pollingInterval ? "Running" : "Stopped");
  });
});

io.on("connection", (socket) => {
  log("Client connected to WebSocket");
  socket.on("disconnect", () => log("Client disconnected"));
});