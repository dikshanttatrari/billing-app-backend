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
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // This runs entirely on the database server, not Node.js memory
    const analytics = await Bill.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      {
        $facet: {
          // 1. Total Stats
          totalStats: [
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: "$total" },
                totalOrders: { $sum: 1 },
                cashSales: {
                  $sum: { $cond: [{ $eq: ["$paymentMode", "cash"] }, "$total", 0] },
                },
                onlineSales: {
                  $sum: { $cond: [{ $ne: ["$paymentMode", "cash"] }, "$total", 0] },
                },
              },
            },
          ],
          // 2. Chart Data (Group by Day)
          dailySales: [
            {
              $group: {
                _id: { $dateToString: { format: "%d/%m", date: "$createdAt" } },
                total: { $sum: "$total" },
              },
            },
            { $sort: { _id: 1 } }, // Sort by date
          ],
          // 3. Top Products
          topProducts: [
            { $unwind: "$items" },
            {
              $group: {
                _id: "$items.name",
                qty: { $sum: "$items.qty" },
              },
            },
            { $sort: { qty: -1 } },
            { $limit: 5 },
          ],
        },
      },
    ]);

    const result = analytics[0];
    const stats = result.totalStats[0] || { totalRevenue: 0, totalOrders: 0, cashSales: 0, onlineSales: 0 };

    // Format for Frontend
    res.json({
      totalRevenue: stats.totalRevenue,
      totalOrders: stats.totalOrders,
      paymentStats: {
        cash: stats.cashSales,
        online: stats.onlineSales,
      },
      chart: {
        labels: result.dailySales.map(d => d._id),
        data: result.dailySales.map(d => d.total),
      },
      topProducts: result.topProducts.map(p => ({ name: p._id, qty: p.qty })),
    });

  } catch (error) {
    console.error("Analytics Error:", error);
    res.status(500).json({ error: "Analytics error" });
  }
});
app.listen(port, () => {
  console.log(`🚀 Server running securely on port ${port}`);
});
