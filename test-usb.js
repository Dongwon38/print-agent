const usb = require("usb");

const devices = usb.getDeviceList();
devices.forEach((device) => {
  console.log("Vendor ID:", device.deviceDescriptor.idVendor.toString(16));
  console.log("Product ID:", device.deviceDescriptor.idProduct.toString(16));
  console.log("Manufacturer:", device.deviceDescriptor.iManufacturer);
  console.log("Product:", device.deviceDescriptor.iProduct);
  console.log("---");
});
