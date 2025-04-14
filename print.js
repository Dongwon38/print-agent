const escpos = require("escpos");
escpos.USB = require("escpos-usb");

const devices = escpos.USB.findPrinter();
if (devices.length === 0) {
  console.log("No USB printer found");
  process.exit();
}

const device = new escpos.USB(
  devices[0].deviceDescriptor.idVendor,
  devices[0].deviceDescriptor.idProduct
);
const options = { encoding: "GB18030" };
const printer = new escpos.Printer(device, options);

device.open(async (error) => {
  if (error) {
    console.error("Printer error:", error);
    return;
  }

  try {
    printer
      .align("CT")
      .style("NORMAL")
      .size(1, 1)
      .text("Test Print")
      .feed(3)
      .cut();

    console.log("Test print sent");

    // 버퍼 플러시
    await new Promise((resolve, reject) => {
      printer.flush((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log("Buffer flushed");

    // 5초 대기 후 닫기
    await new Promise((resolve) => setTimeout(resolve, 5000));
    printer.close();
    console.log("Printer closed");
  } catch (error) {
    console.error("Test print error:", error);
    printer.close();
  }
});
