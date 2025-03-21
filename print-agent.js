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
const PRINTER_NETWORK_IP = process.env.PRINTER_NETWORK_IP || "192.168.1.205";
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
      .size(1, 1)
      .style("B")
      .feed(2); // 상단 2줄 여백

    const orderTime = new Date(order.created_at);
    const pickupTime = new Date(order.due_at);
    const timeDiff = Math.round((pickupTime - orderTime) / (1000 * 60));
    const pickupText = timeDiff >= 0 ? `Pickup in ${timeDiff} minutes` : `Pickup ${Math.abs(timeDiff)} mins ago`;
    printer.text(pickupText);

    printer
      .text(`ORDER #${order.order_number || "N/A"}`)
      .text("-".repeat(33));

    printer
      .text(`Customer: ${order.customer_name || "N/A"}`)
      .text(`Phone: ${order.customer_phone || "N/A"}`)
      .text(`Order Time: ${order.created_at || "N/A"}`)
      .text(`Pickup Time: ${order.due_at || "N/A"}`);

    if (order.customer_notes) {
      printer.text("-".repeat(33)).text("Customer Notes:");
      wrapText(order.customer_notes, 33).forEach(line => printer.text(line));
    }

    printer.text("-".repeat(33)).text("Items:");
    if (cart.length === 0) {
      printer.text("No items in this order.");
    } else {
      cart.forEach((item, index) => {
        if (index > 0) printer.feed(1);
        const itemSubtotal = Number(item.subtotal || item.price * item.quantity || 0).toFixed(2);
        const itemName = `${item.quantity || 1} x ${item.name || item.item_name || "Unknown"}`;
        printer.text(`${itemName} $${itemSubtotal}`);
        printer.text(`- Base Price: $${Number(item.basePrice || item.price || 0).toFixed(2)}`);

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

              const priceText = totalPrice > 0 ? `$${totalPrice.toFixed(2)}` : "Free";
              printer.text(`${optionText} ${priceText}`);
            });
          });
        }

        if (item.specialInstructions) {
          printer.text("- Note:");
          wrapText(item.specialInstructions, 33).forEach(line => printer.text(`  ${line}`));
        }
      });
    }

    printer
      .text("-".repeat(33))
      .text(`Subtotal: $${Number(order.subtotal || 0).toFixed(2)}`)
      .text(`GST (5%): $${Number(order.gst || 0).toFixed(2)}`)
      .text(`PST: $${Number(order.pst || 0).toFixed(2)}`)
      .text(`Deposit Fee: $${Number(order.deposit_fee || 0).toFixed(2)}`)
      .text(`Tip: $${Number(order.tip || 0).toFixed(2)}`)
      .text(`Total: $${Number(order.total || 0).toFixed(2)}`)
      .text("-".repeat(33));

    printer
      .text("Thank you for your order!")
      .text("Night Owl Cafe")
      .text("(604) 276-0576")
      .feed(2) // 하단 2줄 여백
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
  }
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
          await printOrder(order);
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