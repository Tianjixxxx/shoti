const express = require("express");
const cors = require("cors");

const tiktok = require("./tiktok");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// TikTok endpoint
app.get("/tiktok", (req, res) => {
  tiktok.initialize({ req, res });
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Backend running" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
