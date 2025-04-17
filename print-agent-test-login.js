// 250417, 로그인 테스트까지 끝난 버전, node print-agent.js USERNAME PASSWORD, 백엔드에서 설정한 로그인 유효기간 = 30 days

const express = require("express");
const http = require("http");
const axios = require("axios");
require("dotenv").config(); // API_URL과 PORT는 .env에 유지

const app = express();
const server = http.createServer(app);

const API_URL = process.env.NOC_API_URL;
const PORT = process.env.PORT || 3000;

let JWT_TOKEN = null;
let pollingInterval = null;

// 커맨드 라인 인자 처리
const [,, username, password] = process.argv; // node print-agent.js username password

if (!username || !password) {
  console.error("Usage: node print-agent.js <username> <password>");
  process.exit(1);
}

// 로그 파일로 출력
function log(message) {
  const timestamp = new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" });
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage);
  require("fs").appendFile("server.log", logMessage, (err) => {
    if (err) console.error(`Failed to write log: ${err.message}`);
  });
}

// 자동 로그인 및 토큰 갱신
async function autoLogin() {
  if (!username || !password) {
    log("Username or password missing from command line arguments");
    process.exit(1);
  }

  try {
    log("Attempting auto-login...");
    const response = await axios.post(
      `${API_URL}/login`,
      { username, password },
      { headers: { "Content-Type": "application/json" }, withCredentials: true }
    );
    JWT_TOKEN = response.data.token;
    log(`Auto-login successful, JWT_TOKEN: ${JWT_TOKEN}`);
  } catch (error) {
    log(`Auto-login failed: ${error.response?.data?.message || error.message}`);
    process.exit(1);
  }
}

// API 폴링 (프린터 기능 없이 주문 확인만)
async function pollOrders() {
  if (!JWT_TOKEN) {
    await autoLogin();
    if (!JWT_TOKEN) return;
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
        if (!order.print_status && order.payment_status === "paid") {
          log(`Order #${order.order_number || "N/A"} is ready to print (printer not initialized yet)`);
          // 프린터 관련 코드는 이후 로드
        }
      }
    } else {
      log(`${time}: No new orders`);
    }
  } catch (error) {
    const status = error.response?.status;
    const errorMsg = error.response?.data?.message || error.message;
    log(`Failed to fetch orders: ${status || "Unknown"} - ${errorMsg}`);
    if (status === 401 || status === 403) {
      log("Token expired, attempting re-login...");
      JWT_TOKEN = null;
      await autoLogin();
      if (JWT_TOKEN) {
        log("Re-login successful, resuming polling");
      } else {
        log("Re-login failed, exiting...");
        process.exit(1);
      }
    }
  }
}

// 초기화
async function init() {
  if (!username || !password) {
    log("Required username and password are missing from command line arguments");
    process.exit(1);
  }

  await autoLogin();
  if (!JWT_TOKEN) {
    log("Failed to obtain token, exiting...");
    process.exit(1);
  }
}

// 서버 시작
init().then(() => {
  log(`Starting server on port ${PORT}`);
  pollOrders();
  pollingInterval = setInterval(pollOrders, 3000);
  server.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
  });
});

// 프로세스 종료 시
process.on("SIGINT", async () => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    log("Polling stopped");
  }
  log("Server shutdown complete");
  process.exit();
});