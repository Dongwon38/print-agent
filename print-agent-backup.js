const axios = require('axios');

// 프린터 설정 제거 (시뮬레이션용)
// const ThermalPrinter = require('node-thermal-printer').printer;
// const PrinterTypes = require('node-thermal-printer').types;
// const printer = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: 'printer:PDF Printer' });

const API_URL = 'https://dongwonk5.sg-host.com/wp-json/custom/v1';

async function pollOrders() {
    try {
        const response = await axios.get(`${API_URL}/pending-orders`);
        const orders = response.data;

        const time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Vancouver' });

        if (orders.length > 0) {
            console.log(`Found ${orders.length} new orders`);
            for (const order of orders) {
                await printOrder(order);
                await markOrderAsPrinted(order.id);
            }
        } else {
            console.log(time, ': No new order.');
        }
    } catch (error) {
        console.error('Polling error:', error.message);
    }
}

async function printOrder(order) {
    const cart = JSON.parse(order.cart);

    // 프린터 대신 콘솔에 출력
    console.log('--- Start Printing ---');
    console.log(`Order #${order.order_number}`);
    console.log(`Customer: ${order.customer_name}`);
    console.log(`Type: ${order.order_type}`);
    console.log('---------------------');

    console.log(cart)
    // cart.forEach(item => {
    //     console.log(`${item.n} - $${item.subtotal.toFixed(2)}`);
    // });
    console.log('---------------------');

    console.log(`Subtotal: $${order.subtotal}`);
    console.log(`GST: $${order.gst}`);
    console.log(`PST: $${order.pst}`);
    console.log(`Tip: $${order.tip}`);
    console.log(`Total: $${order.total}`);
    console.log(`Print Status: ${order.print_status}`);
    console.log('--- End Printing ---');

    // await printer.execute(); 제거
    console.log(`Printed order #${order.order_number}`);
}

async function markOrderAsPrinted(orderId) {
    try {
        await axios.post(`${API_URL}/update-print-status`, {
            order_id: orderId,
            print_status: 'printed'
        });
        console.log(`Marked order #${orderId} as printed`);
    } catch (error) {
        console.error('Update error:', error.message);
    }
}

// 5초마다 polling
setInterval(pollOrders, 5000);

// 초기 실행
pollOrders();