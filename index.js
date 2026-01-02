const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const morgan = require("morgan");

const Product = require("./models/Product");
const Bill = require("./models/Bill");
const Counter = require("./models/Counter");

dotenv.config();

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

app.use(cors());

app.use(helmet());

app.use(compression());

app.use(express.json({ limit: "10kb" }));

app.use(morgan("tiny"));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests from this IP, please try again later.",
});
app.use("/api", limiter);

// --- 2. DATABASE CONNECTION ---
mongoose
  .connect(process.env.MONGO_DB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// --- 3. ROUTES ---

// Health Check
app.get("/health", (req, res) => res.send("API is secure and running..."));

// ADD ITEM
app.post("/api/add-item", async (req, res) => {
  try {
    const { name, barcode, price } = req.body;
    if (!name || !barcode || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const newProduct = new Product({ name, barcode, price: parseFloat(price) });
    const savedProduct = await newProduct.save();
    res.status(201).json({ message: "Product added", product: savedProduct });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "Barcode already exists." });
    }
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// GET PRODUCT BY BARCODE
app.get("/api/products/:barcode", async (req, res) => {
  try {
    const product = await Product.findOne({
      barcode: req.params.barcode,
    }).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET ALL PRODUCTS
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 }).lean();
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE PRODUCT
app.delete("/api/products/:id", async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// UPDATE PRODUCT
app.put("/api/products/:id", async (req, res) => {
  try {
    const { name, barcode, price } = req.body;

    // Check if barcode belongs to another product
    const existing = await Product.findOne({ barcode });
    if (existing && existing._id.toString() !== req.params.id) {
      return res.status(409).json({ error: "Barcode already taken" });
    }

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { name, barcode, price },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: "Not found" });
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// CREATE BILL
app.post("/api/bills", async (req, res) => {
  try {
    const { customerPhone, items, total, paymentMode } = req.body;

    // Atomic counter increment
    const counter = await Counter.findOneAndUpdate(
      { id: "bill_seq" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const newBill = new Bill({
      billNumber: `INV-${counter.seq}`,
      customerPhone,
      items,
      total,
      paymentMode,
    });

    const savedBill = await newBill.save();
    res.status(201).json({
      message: "Bill saved",
      billId: savedBill._id,
      billNumber: savedBill.billNumber,
      date: savedBill.createdAt,
    });
  } catch (error) {
    console.error("Billing Error:", error);
    res.status(500).json({ error: "Failed to save bill" });
  }
});

// GET BILLS (Limit to 50 to prevent app crash on load)
app.get("/api/bills", async (req, res) => {
  try {
    const bills = await Bill.find().sort({ createdAt: -1 }).limit(50).lean();
    res.status(200).json(bills);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// --- OPTIMIZED ANALYTICS (MongoDB Aggregation) ---
app.get("/api/analytics", async (req, res) => {
  try {
    const sevenDaysAgo = new Date();

    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const bills = await Bill.find({
      createdAt: { $gte: sevenDaysAgo },
    }).sort("createdAt");

    let totalRevenue = 0;

    let totalOrders = bills.length;

    let paymentStats = { cash: 0, online: 0 };

    let salesByDate = {};

    let productMap = {};

    for (let i = 0; i < 7; i++) {
      const d = new Date();

      d.setDate(d.getDate() - i);

      const dateStr = `${d.getDate()}/${d.getMonth() + 1}`;

      salesByDate[dateStr] = 0;
    }

    bills.forEach((bill) => {
      totalRevenue += bill.total;

      if (bill.paymentMode === "cash") paymentStats.cash += bill.total;
      else paymentStats.online += bill.total;

      const date = new Date(bill.createdAt);

      const dateStr = `${date.getDate()}/${date.getMonth() + 1}`;

      if (salesByDate[dateStr] !== undefined) {
        salesByDate[dateStr] += bill.total;
      }

      bill.items.forEach((item) => {
        if (!productMap[item.name]) productMap[item.name] = 0;

        productMap[item.name] += item.qty;
      });
    });

    const topProducts = Object.entries(productMap)

      .map(([name, qty]) => ({ name, qty }))

      .sort((a, b) => b.qty - a.qty)

      .slice(0, 5);

    const chartLabels = Object.keys(salesByDate).reverse();

    const chartData = Object.values(salesByDate).reverse();

    res.json({
      totalRevenue,

      totalOrders,

      paymentStats,

      chart: { labels: chartLabels, data: chartData },

      topProducts,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({ error: "Analytics error" });
  }
});
app.listen(port, () => {
  console.log(`🚀 Server running securely on port ${port}`);
});
