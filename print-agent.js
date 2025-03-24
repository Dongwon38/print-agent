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

const API_URL = process.env.API_URL;
const PORT = process.env.PORT;
const PRINTER_NETWORK_IP = process.env.PRINTER_NETWORK_IP;
const TOKEN_FILE = "./jwt_token.txt";

let JWT_TOKEN = null;
let pollingInterval = null;

function log(message) {
  console.log(`[${new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" })}] ${message}`);
  io.emit("log", message);
}

function updateStatus(status) {
  io.emit("status", status);
}

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

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

async function printOrder(order) {
  let cart;
  try {
    cart = order.cart ? JSON.parse(order.cart) : [];
  } catch (e) {
    log(`Error parsing cart for order #${order.order_number}: ${e.message}`);
    return;
  }

  const device = new escpos.Network(PRINTER_NETWORK_IP);
  const printer = new escpos.Printer(device);

  try {
    await new Promise((resolve, reject) => {
      device.open((err) => (err ? reject(err) : resolve()));
    });

    printer
      .font("a")
      .style("B")
      .feed(2);

    // 주문 번호
    printer
      .size(2, 2)
      .align("ct")
      .text(`ORDER #${order.order_number || "N/A"}`)
      .size(1, 1)
      .text("-".repeat(33));

    // 픽업 시간 (형식 변경)
    const orderTime = new Date(order.created_at).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });
    const pickupTime = new Date(order.due_at).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });
    const timeDiff = Math.round((new Date(order.due_at) - new Date(order.created_at)) / (1000 * 60));
    const pickupText = timeDiff >= 0 ? `Pickup in ${timeDiff} minutes` : `Pickup ${Math.abs(timeDiff)} mins ago`;
    printer
      .style("BU")
      .text(pickupText)
      .style("B");

    // 고객 정보
    printer
      .align("lt")
      .text(`Customer: ${order.customer_name || "N/A"}`)
      .text(`Phone: ${order.customer_phone || "N/A"}`)
      .text(`Order Time: ${orderTime || "N/A"}`)
      .text(`Pickup Time: ${pickupTime || "N/A"}`);

    // 고객 노트
    if (order.customer_notes) {
      printer
        .text("-".repeat(33))
        .font("b")
        .text("Customer Notes:")
        .font("a");
      wrapText(order.customer_notes, 33).forEach(line => printer.text(line));
    }

    // 아이템 목록
    printer
      .text("-".repeat(33))
      .text("Items:");
    if (cart.length === 0) {
      printer.text("No items in this order.");
    } else {
      cart.forEach((item, index) => {
        const itemSubtotal = Number(item.subtotal || item.price * item.quantity || 0).toFixed(2);
        const itemName = `${item.quantity || 1} x ${item.name || item.item_name || "Unknown"}`;
        const priceText = `$${itemSubtotal}`;

        // 긴 이름 처리
        printer.size(1, 1); // 큰 글씨로 아이템
        const lines = wrapTextWithPrice(itemName, 25, priceText); // 25자는 이름 공간, 총 33자 기준
        lines.forEach((line, i) => {
          if (i === 0) {
            printer.text(line.padEnd(33 - priceText.length) + priceText); // 첫 줄에 가격
          } else {
            printer.text(line); // 나머지 줄은 이름만
          }
        });
        printer.size(1, 1); // 기본 크기로 복귀

        // 옵션 (큰 글씨)
        if (item.options && item.options.length > 0) {
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              let optionText = `- ${choice.name || "N/A"}`;
              let totalPrice = Number(choice.extraPrice || choice.additional_price || choice.price || 0);

              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    const subPrice = Number(subChoice.extraPrice || subChoice.additional_price || subChoice.price || 0);
                    totalPrice += subPrice;
                    optionText += ` - ${subChoice.name || "N/A"}`;
                  });
                });
              }

              const priceTextOption = totalPrice > 0 ? `$${totalPrice.toFixed(2)}` : "(CA$0.00)";
              const optionLines = wrapTextWithPrice(optionText, 25, priceTextOption);
              optionLines.forEach((line, i) => {
                if (i === 0) {
                  printer.text(line.padEnd(33 - priceTextOption.length) + priceTextOption);
                } else {
                  printer.text(line);
                }
              });
            });
          });
        }

        // 특이사항
        if (item.specialInstructions) {
          printer
            .font("b")
            .text("- Note:")
            .font("a");
          wrapText(item.specialInstructions, 33).forEach(line => printer.text(`  ${line}`));
        }

        // 아이템 간 구분선
        if (index < cart.length - 1) {
          printer.text("-".repeat(33));
        }
      });
    }

    // 합계
    printer
      .text("-".repeat(33))
      .align("rt")
      .text(`Subtotal: $${Number(order.subtotal || 0).toFixed(2)}`)
      .text(`GST (5%): $${Number(order.gst || 0).toFixed(2)}`)
      .text(`Tip: $${Number(order.tip || 0).toFixed(2)}`)
      .size(1, 1)
      .text(`Total: $${Number(order.total || 0).toFixed(2)}`)
      .size(1, 1);

    // 마무리
    printer
      .align("ct")
      .text("-".repeat(33))
      .text("Thank you for your order!")
      .text("Night Owl Cafe")
      .text("(604) 276-0576")
      .feed(3)
      .cut();

    await new Promise((resolve) => printer.close(() => resolve()));
    log(`Printed order #${order.order_number || "N/A"} on Network (${PRINTER_NETWORK_IP})`);

    await axios.post(
      `${API_URL}/update-print-status`,
      { order_id: order.id, print_status: "printed" },
      { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
    );
    log(`Marked order #${order.id} as printed`);
  } catch (error) {
    log(`Print error for order #${order.order_number || "N/A"} on Network (${PRINTER_NETWORK_IP}): ${error.message}`);
  } finally {
    // 프린터 연결 해제 및 초기화
    printer.raw(Buffer.from([0x1B, 0x40])); // ESC @로 초기화
    await new Promise((resolve) => printer.close(() => resolve()));
  }
}

// 긴 텍스트를 가격과 분리해서 줄 바꿈 처리
function wrapTextWithPrice(text, maxWidth, price) {
  const lines = [];
  let currentLine = "";

  const words = text.split(" ");
  words.forEach((word) => {
    if ((currentLine + " " + word).length <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length <= maxWidth ? word : word.slice(0, maxWidth);
    }
  });
  if (currentLine) lines.push(currentLine);
  return lines;
}

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
    const orders = response.data || [];
    const time = new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" });

    if (orders.length > 0) {
      log(`Found ${orders.length} new orders`);
      for (const order of orders) {
        if (!order.print_status && order.payment_status === 'paid') {
          log(`Order #${order.order_number || "N/A"} detected, printing...`);
          await printOrder(order);  // Print order first
          await printOrder(order);  // Print order again
        } else {
          log(`Order #${order.order_number || "N/A"} already printed or not paid`);
        }
      }
    } else {
      log(`${time}: No new orders found.`);
    }
  } catch (error) {
    const status = error.response?.status;
    const errorMsg = error.response?.data?.message || error.message;
    log(`Polling error: ${status || "Unknown"} - ${errorMsg}`);
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

async function init() {
  try {
    if (await fs.access(TOKEN_FILE).then(() => true).catch(() => false)) {
      JWT_TOKEN = await fs.readFile(TOKEN_FILE, "utf8");
      log("Loaded saved token");
    } else {
      log("No saved token found, please login.");
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

function wrapText(text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  words.forEach((word) => {
    if ((currentLine + " " + word).length <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length <= maxWidth ? word : word.slice(0, maxWidth);
    }
  });
  if (currentLine) lines.push(currentLine);
  return lines;
}