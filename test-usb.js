const usb = require("usb");

const devices = usb.getDeviceList();
console.log(
  "USB devices:",
  devices.map((d) => ({
    vid: d.deviceDescriptor.idVendor.toString(16),
    pid: d.deviceDescriptor.idProduct.toString(16),
  }))
);

const printerDevice = devices.find(
  (d) =>
    d.deviceDescriptor.idVendor === 0x04b8 &&
    d.deviceDescriptor.idProduct === 0x0202
);
if (printerDevice) {
  console.log("Found EPSON TM-T88IV:", printerDevice.deviceDescriptor);
  printerDevice.open();
  printerDevice.close();
  console.log("Device opened and closed successfully");
} else {
  console.log("EPSON TM-T88IV not found");
}
