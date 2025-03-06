const axios = require("axios");
const express = require('express');
const cors = require('cors'); // cors 모듈 임포트 추가

const app = express();
app.use(express.json());
app.use(cors()); 
// 모든 출처 허용 (테스트용)
// 주석: 배포 시 특정 출처만 허용하려면 아래처럼 수정
// app.use(cors({ origin: 'http://localhost:5174' }));

const API_URL = "https://dongwonk5.sg-host.com/wp-json/custom/v1";
// 주석: 새 레스토랑의 WordPress URL로 변경 시 API_URL을 업데이트하세요 (예: "https://newrestaurant.com/wp-json/custom/v1").

async function pollOrders() {
  try {
    const response = await axios.get(`${API_URL}/pending-orders`);
    const orders = response.data;

    const time = new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    });

    if (orders.length > 0) {
      console.log(`Found ${orders.length} new orders`);
      for (const order of orders) {
        await printOrder(order);
        await markOrderAsPrinted(order.id);
      }
    } else {
      console.log(time, ": No new order.");
    }
  } catch (error) {
    console.error("Polling error:", error.message);
  }
}

async function printOrder(order) {
  let cart;
  try {
    cart = JSON.parse(order.cart);
  } catch (e) {
    console.error("Error parsing cart:", e.message);
    cart = [];
  }

  try {
    // 주석: 아래는 원래 프린터 출력 코드로, 테스트용으로 콘솔 로그로 대체
    /*
    console.log("Opening device...");
    await new Promise((resolve, reject) => {
      device.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    console.log("Device opened successfully");

    printer.font("a").align("ct");
    printer
      .text(`ORDER #${order.order_number}`)
      .text("----------------------------------------");

    printer
      .align("lt")
      .text(`Customer: ${order.customer_name}`)
      .text(`Phone: ${order.customer_phone}`)
      .text(`Email: ${order.customer_email || "N/A"}`)
      .text(`Order Time: ${order.created_at}`)
      .text(`Pickup Time: ${order.due_at}`)
      .text(`Order Type: ${order.order_type}`)
      .text("----------------------------------------");

    printer.text("Items:");
    cart.forEach((item, index) => {
      const itemLine =
        `${index + 1}. ${item.name}`.padEnd(35) +
        `$${Number(item.subtotal).toFixed(2)}`;
      printer.text(itemLine);
      const basePriceLine =
        "   Base Price:".padEnd(35) + `$${Number(item.basePrice).toFixed(2)}`;
      printer.text(basePriceLine);
      item.options.forEach((option) => {
        option.choices.forEach((choice) => {
          const optionLine =
            `   - ${option.category}: ${choice.name}`.padEnd(35) +
            `$${Number(choice.extraPrice).toFixed(2)}`;
          printer.text(optionLine);
        });
      });
    });
    printer.text("----------------------------------------");

    printer
      .text(`Subtotal:`.padEnd(35) + `$${Number(order.subtotal).toFixed(2)}`)
      .text(`GST (5%):`.padEnd(35) + `$${Number(order.gst).toFixed(2)}`)
      .text(`PST:`.padEnd(35) + `$${Number(order.pst).toFixed(2)}`)
      .text(`Bag Fee:`.padEnd(35) + `$${Number(order.bag_fee).toFixed(2)}`)
      .text(`Deposit Fee:`.padEnd(35) + `$${Number(order.deposit_fee).toFixed(2)}`)
      .text(`Tip:`.padEnd(35) + `$${Number(order.tip).toFixed(2)}`)
      .text(`Total:`.padEnd(35) + `$${Number(order.total).toFixed(2)}`)
      .text("----------------------------------------");

    printer
      .align("ct")
      .text("Thank you for your order!")
      .feed(4)
      .cut();

    await new Promise((resolve, reject) => {
      printer.close(() => resolve(), reject);
    });
    console.log("Device closed");
    */

    // 테스트용 콘솔 로그 출력
    console.log(`===== ORDER #${order.order_number} =====`);
    console.log("----------------------------------------");
    console.log(`Customer: ${order.customer_name}`);
    console.log(`Phone: ${order.customer_phone}`);
    console.log(`Email: ${order.customer_email || "N/A"}`);
    console.log(`Order Time: ${order.created_at}`);
    console.log(`Pickup Time: ${order.due_at}`);
    console.log(`Order Type: ${order.order_type}`);
    console.log("----------------------------------------");
    console.log("Items:");
    cart.forEach((item, index) => {
      const itemLine =
        `${index + 1}. ${item.name}`.padEnd(35) +
        `$${Number(item.subtotal).toFixed(2)}`;
      console.log(itemLine);
      const basePriceLine =
        "   Base Price:".padEnd(35) + `$${Number(item.basePrice).toFixed(2)}`;
      console.log(basePriceLine);
      item.options.forEach((option) => {
        option.choices.forEach((choice) => {
          const optionLine =
            `   - ${option.category}: ${choice.name}`.padEnd(35) +
            `$${Number(choice.extraPrice).toFixed(2)}`;
          console.log(optionLine);
        });
      });
    });
    console.log("----------------------------------------");
    console.log(`Subtotal:`.padEnd(35) + `$${Number(order.subtotal).toFixed(2)}`);
    console.log(`GST (5%):`.padEnd(35) + `$${Number(order.gst).toFixed(2)}`);
    console.log(`PST:`.padEnd(35) + `$${Number(order.pst).toFixed(2)}`);
    console.log(`Bag Fee:`.padEnd(35) + `$${Number(order.bag_fee).toFixed(2)}`);
    console.log(`Deposit Fee:`.padEnd(35) + `$${Number(order.deposit_fee).toFixed(2)}`);
    console.log(`Tip:`.padEnd(35) + `$${Number(order.tip).toFixed(2)}`);
    console.log(`Total:`.padEnd(35) + `$${Number(order.total).toFixed(2)}`);
    console.log("----------------------------------------");
    console.log("Thank you for your order!");
    console.log("===== End of Order =====");

    console.log(`Printed order #${order.order_number}`);
  } catch (error) {
    console.error("Print error:", error.message);
    throw error;
  }
}

async function markOrderAsPrinted(orderId) {
  try {
    await axios.post(`${API_URL}/update-print-status`, {
      order_id: orderId,
      print_status: "printed",
    });
    console.log(`Marked order #${orderId} as printed`);
  } catch (error) {
    console.error("Update error:", error.message);
  }
}

// Reprint 엔드포인트 추가
app.post('/reprint', async (req, res) => {
  const { orderId } = req.body;
  try {
    // 주석: 새 레스토랑에서 WordPress URL 변경 시 API_URL과 함께 /orders/{orderId} 경로 확인 필요
    const response = await axios.get(`${API_URL}/orders/${orderId}`);
    const order = response.data;
    await printOrder(order);
    console.log(`Reprinted order #${order.order_number}`);
    res.status(200).json({ success: true, message: `Order ${order.order_number} reprinted` });
  } catch (error) {
    console.error("Reprint error:", error.message);
    res.status(500).json({ success: false, message: "Failed to reprint order" });
  }
});

setInterval(pollOrders, 5000);
pollOrders();

// 주석: 새 레스토랑에서 포트 변경 시 3000을 새 포트 번호로 수정하세요 (예: 4000)
app.listen(3000, () => console.log('Node server on port 3000'));