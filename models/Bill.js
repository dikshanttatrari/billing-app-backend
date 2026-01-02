const mongoose = require("mongoose");

const BillSchema = new mongoose.Schema({
  billNumber: { type: String, required: true },
  customerPhone: { type: String, default: "" },
  total: { type: Number, required: true },
  paymentMode: { type: String, required: true },
  items: Array,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Bill", BillSchema);
