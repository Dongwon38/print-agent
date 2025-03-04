const ThermalPrinter = require('node-thermal-printer').printer;
const PrinterTypes = require('node-thermal-printer').types;

const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: 'printer:EPSON TM-T88IV Receipt', // 확인한 이름 사용
});

printer.isPrinterConnected().then(connected => {
    console.log('Printer connected:', connected);
    if (connected) {
        printer.println('Test Print from Node.js');
        printer.cut();
        printer.execute().then(() => console.log('Print successful')).catch(err => console.error('Print error:', err));
    }
}).catch(err => {
    console.error('Connection error:', err.message);
});