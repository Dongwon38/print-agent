const axios = require('axios');
const ThermalPrinter = require('node-thermal-printer').printer;
const PrinterTypes = require('node-thermal-printer').types;

// 프린터 설정 (Windows에서 USB 연결 기준)
const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON, // EPSON 프린터 유형
    interface: 'printer:EPSON TM-T88IV Receipt', // Windows에서 확인한 정확한 프린터 이름
    // 네트워크 연결이라면: 'tcp://192.168.1.100:9100' (프린터 IP와 포트로 수정)
});

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
    let cart;
    try {
        cart = JSON.parse(order.cart);
    } catch (e) {
        console.error('Error parsing cart:', e.message);
        cart = [];
    }

    // 프린터 명령어 작성
    printer.alignCenter();
    printer.println(`Order #${order.order_number}`);
    printer.println(`Customer: ${order.customer_name}`);
    printer.println(`Type: ${order.order_type}`);
    printer.println(`Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver' })}`);
    printer.drawLine();

    printer.alignLeft();
    if (Array.isArray(cart) && cart.length > 0) {
        cart.forEach(item => {
            printer.println(`${item.n} - $${Number(item.subtotal).toFixed(2)}`);
            if (item.o && item.o.length > 0) {
                printer.println(`  Options: ${item.o.map(opt => `${opt.category}: ${opt.choices.map(c => c.name).join(', ')}`).join(' | ')}`);
            }
        });
    } else {
        printer.println('No items in cart');
    }
    printer.drawLine();

    printer.println(`Subtotal: $${Number(order.subtotal).toFixed(2)}`);
    printer.println(`GST: $${Number(order.gst).toFixed(2)}`);
    printer.println(`PST: $${Number(order.pst).toFixed(2)}`);
    printer.println(`Tip: $${Number(order.tip).toFixed(2)}`);
    printer.println(`Total: $${Number(order.total).toFixed(2)}`);
    printer.cut();

    // 프린터 실행
    try {
        await printer.execute();
        console.log(`Printed order #${order.order_number}`);
    } catch (error) {
        console.error('Printing error:', error.message);
    }
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

setInterval(pollOrders, 5000);
pollOrders();

// 프린터 명령어:
// printer.println()으로 텍스트 출력.
// printer.alignCenter()/alignLeft()로 정렬.
// printer.drawLine()로 구분선 추가.
// printer.cut()으로 용지 자름.
// await printer.execute()로 실제 출력.