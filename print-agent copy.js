const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const axios = require("axios");
const fs = require("fs").promises;
const ThermalPrinter = require("node-thermal-printer").printer;
const PrinterTypes = require("node-thermal-printer").types;
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
  console.log(
    `[${new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    })}] ${message}`
  );
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
    return res
      .status(401)
      .json({ status: "error", message: "Not authenticated" });
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

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${PRINTER_NETWORK_IP}:9100`,
    characterSet: "SLOVENIA",
    removeSpecialCharacters: false,
    lineCharacter: "-",
  });

  try {
    // 프린터 연결 확인
    const isConnected = await printer.isPrinterConnected();
    if (!isConnected) {
      throw new Error("Printer not connected");
    }

    // 초기화
    printer.clear();
    // 주문 번호 (글씨 크기 2배)
    printer.setTextDoubleHeight();
    printer.setTextDoubleWidth();
    printer.alignCenter();
    printer.println(`ORDER #${order.order_number || "N/A"}`);
    printer.setTextNormal();
    printer.alignLeft();
    printer.println(`---------------------------------`);

    // 픽업 시간
    const orderDate = new Date(order.created_at);
    const pickupDate = new Date(order.due_at);

    // 시간 차이 계산 (분 단위)
    const timeDiff = Math.round((pickupDate - orderDate) / (1000 * 60));

    // 픽업 시간 포맷팅
    const pickupTimeFormat = pickupDate.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });
    const pickupTimeWithDateFormat = pickupDate.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });

    // 주문 날짜와 픽업 날짜 비교
    const isSameDay =
      orderDate.toLocaleDateString("en-US", {
        timeZone: "America/Vancouver",
      }) ===
      pickupDate.toLocaleDateString("en-US", { timeZone: "America/Vancouver" });

    let pickupText;
    if (!isSameDay) {
      // 주문 날짜와 픽업 날짜가 다를 경우 (다음 날부터)
      pickupText = `Pickup at ${pickupTimeWithDateFormat}`;
    } else if (timeDiff < 60) {
      // 1시간 이내
      pickupText = `Pickup at ${pickupTimeFormat} (in ${timeDiff} mins)`;
    } else {
      // 1시간 이상
      const hours = Math.floor(timeDiff / 60);
      const minutes = timeDiff % 60;
      pickupText = `Pickup at ${pickupTimeFormat} (in ${hours} hr ${minutes} mins)`;
    }

    printer.setTextDoubleHeight();
    printer.println(pickupText);
    printer.setTextNormal();

    // 고객 정보
    printer.alignLeft();
    const orderTime = orderDate.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });
    printer.println(`Customer: ${order.customer_name || "N/A"}`);
    printer.println(`Phone: ${order.customer_phone || "N/A"}`);
    printer.println(`Order Time: ${orderTime || "N/A"}`);
    printer.println(`Pickup Time: ${pickupTimeWithDateFormat || "N/A"}`);

    // 고객 노트
    if (order.customer_notes) {
      printer.drawLine();
      printer.setTextNormal();
      printer.println("Customer Notes:");
      wrapText(order.customer_notes, 33).forEach((line) =>
        printer.println(line)
      );
    }

    // 아이템 목록
    printer.drawLine();
    if (cart.length === 0) {
      printer.println("No items in this order.");
    } else {
      cart.forEach((item, index) => {
        const itemSubtotal = Number(
          item.subtotal || item.price * item.quantity || 0
        ).toFixed(2);
        const itemName = `${item.quantity || 1} x ${
          item.name || item.item_name || "Unknown"
        }`;
        const priceText = `  $${itemSubtotal}`;

        // 아이템 (글씨 크기 2배)
        printer.setTextDoubleHeight();
        const lines = wrapTextWithPrice(itemName, 20, priceText);
        lines.forEach((line, i) => {
          if (i === 0) {
            printer.println(line.padEnd(33 - priceText.length) + priceText);
          } else {
            printer.println(line);
          }
        });
        printer.setTextNormal();

        if (item.options && item.options.length > 0) {
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              let optionText = `- ${choice.name || "N/A"}`;
              let totalPrice = Number(
                choice.extraPrice ||
                  choice.additional_price ||
                  choice.price ||
                  0
              );

              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    const subPrice = Number(
                      subChoice.extraPrice ||
                        subChoice.additional_price ||
                        subChoice.price ||
                        0
                    );
                    totalPrice += subPrice;
                    optionText += ` - ${subChoice.name || "N/A"}`;
                  });
                });
              }

              const priceTextOption =
                totalPrice > 0 ? `$${totalPrice.toFixed(2)}` : "(CA$0.00)";
              const optionLines = wrapTextWithPrice(
                optionText,
                20,
                priceTextOption
              );
              optionLines.forEach((line, i) => {
                if (i === 0) {
                  printer.println(
                    line.padEnd(33 - priceTextOption.length) + priceTextOption
                  );
                } else {
                  printer.println(line);
                }
              });
            });
          });
        }

        if (item.specialInstructions) {
          printer.println("- Note:");
          wrapText(item.specialInstructions, 33).forEach((line) =>
            printer.println(`  ${line}`)
          );
        }

        if (index < cart.length - 1) {
          printer.drawLine();
        }
      });
    }

    // 합계
    printer.drawLine();
    printer.alignRight();
    printer.println(`Subtotal: $${Number(order.subtotal || 0).toFixed(2)}`);
    printer.println(`GST (5%): $${Number(order.gst || 0).toFixed(2)}`);
    printer.println(`Tip: $${Number(order.tip || 0).toFixed(2)}`);
    printer.setTextDoubleHeight();
    printer.println(`Total: $${Number(order.total || 0).toFixed(2)}`);
    printer.setTextNormal();

    // 마무리
    printer.alignCenter();
    printer.drawLine();
    printer.println("Thank you for your order!");
    printer.println("Night Owl Cafe");
    printer.println("#104-8580 Cambie Rd, Richmond, BC");
    printer.println("(604) 276-0576");
    printer.newLine();
    printer.newLine();
    printer.newLine();
    printer.cut();

    await printer.execute();
    log(
      `Printed order #${
        order.order_number || "N/A"
      } on Network (${PRINTER_NETWORK_IP})`
    );

    await axios.post(
      `${API_URL}/update-print-status`,
      { order_id: order.id, print_status: "printed" },
      { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
    );
    log(`Marked order #${order.id} as printed`);
  } catch (error) {
    log(
      `Print error for order #${
        order.order_number || "N/A"
      } on Network (${PRINTER_NETWORK_IP}): ${error.message}`
    );
  } finally {
    printer.clear();
    await printer.execute();
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
    const time = new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    });

    if (orders.length > 0) {
      log(`Found ${orders.length} new orders`);
      for (const order of orders) {
        if (!order.print_status && order.payment_status === "paid") {
          log(`Order #${order.order_number || "N/A"} detected, printing...`);
          await printOrder(order); // Print order first
          // await printOrder(order);  // Print order again (주석 처리된 부분 유지)
        } else {
          log(
            `Order #${order.order_number || "N/A"} already printed or not paid`
          );
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
    if (
      await fs
        .access(TOKEN_FILE)
        .then(() => true)
        .catch(() => false)
    ) {
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
