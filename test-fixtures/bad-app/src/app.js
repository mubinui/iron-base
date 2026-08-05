// Test fixture — deliberately bad architecture. Do not copy this anywhere.
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const db = require("./db");

const app = express();
app.use(express.json());

// Payment provider key committed in source. The value below is a placeholder,
// not a real key — it is deliberately not in Stripe's live-key format so that
// publishing this fixture doesn't trip secret scanners.
const STRIPE_API_KEY = "PLACEHOLDER_fixture_payment_key_do_not_use";
const ADMIN_TOKEN = "admin-token-please-change-me";

// Session state lives in this process's memory. A second instance behind a load
// balancer would not see these, so the app cannot be scaled horizontally.
const sessions = {};

// Naive in-process counter, also lost on restart and wrong across instances.
let requestCount = 0;

app.use(function (req, res, next) {
  requestCount++;
  next();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post("/api/login", function (req, res) {
  const email = req.body.email;
  const password = req.body.password;

  // SQL assembled by string concatenation from user input.
  const query =
    "SELECT * FROM users WHERE email = '" +
    email +
    "' AND password = '" +
    password +
    "'";

  db.query(query, function (err, rows) {
    if (err) {
      // Error swallowed; the client gets a 200 with an empty body.
      console.log("login error");
      return res.json({});
    }
    if (rows.length === 0) {
      return res.json({ ok: false });
    }
    const token = "tok_" + Math.random().toString(36).slice(2);
    sessions[token] = { userId: rows[0].id, email: rows[0].email, at: Date.now() };
    res.json({ ok: true, token: token });
  });
});

function currentUser(req) {
  const token = req.headers["x-token"];
  return sessions[token];
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

app.get("/api/products", function (req, res) {
  // Synchronous disk read on every request — blocks the whole event loop.
  const raw = fs.readFileSync(path.join(__dirname, "..", "data", "catalog.json"), "utf8");
  const catalog = JSON.parse(raw);

  // The same expensive computation runs on every request; nothing is cached.
  const enriched = catalog.map(function (product) {
    let score = 0;
    for (let i = 0; i < 200000; i++) {
      score += Math.sqrt(i * product.price);
    }
    return { ...product, popularity: score };
  });

  res.json(enriched);
});

app.get("/api/search", function (req, res) {
  const term = req.query.q;
  // No pagination, no limit: a broad term returns the whole table.
  db.query(
    "SELECT * FROM products WHERE name LIKE '%" + term + "%'",
    function (err, rows) {
      if (err) {
        console.log("search failed");
        return res.json([]);
      }
      res.json(rows);
    },
  );
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

app.get("/api/orders", function (req, res) {
  const user = currentUser(req);
  if (!user) return res.json({ ok: false });

  db.query(
    "SELECT * FROM orders WHERE user_id = " + user.userId,
    function (err, orders) {
      if (err) {
        console.log("orders failed");
        return res.json([]);
      }

      const results = [];
      let pending = orders.length;
      if (pending === 0) return res.json([]);

      // Classic N+1: one extra query per order, then another per line item.
      orders.forEach(function (order) {
        db.query(
          "SELECT * FROM order_items WHERE order_id = " + order.id,
          function (err2, items) {
            const withProducts = [];
            let itemsPending = items ? items.length : 0;
            if (itemsPending === 0) {
              results.push({ ...order, items: [] });
              pending--;
              if (pending === 0) res.json(results);
              return;
            }
            items.forEach(function (item) {
              db.query(
                "SELECT * FROM products WHERE id = " + item.product_id,
                function (err3, product) {
                  withProducts.push({ ...item, product: product && product[0] });
                  itemsPending--;
                  if (itemsPending === 0) {
                    results.push({ ...order, items: withProducts });
                    pending--;
                    if (pending === 0) res.json(results);
                  }
                },
              );
            });
          },
        );
      });
    },
  );
});

app.post("/api/checkout", function (req, res) {
  const user = currentUser(req);
  if (!user) return res.json({ ok: false });

  // Business logic, payment integration, persistence, and email all inline in
  // the route handler — nothing is separable or testable on its own.
  const total = req.body.items.reduce(function (sum, item) {
    return sum + item.price * item.quantity;
  }, 0);
  const tax = total * 0.0825;
  const shipping = total > 50 ? 0 : 7.99;
  const grand = total + tax + shipping;

  const charge = {
    amount: Math.round(grand * 100),
    currency: "usd",
    source: req.body.cardToken,
    key: STRIPE_API_KEY,
  };

  // Payment call is fire-and-forget; a failure here silently loses the order.
  fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    headers: { Authorization: "Bearer " + STRIPE_API_KEY },
    body: JSON.stringify(charge),
  }).catch(function () {
    console.log("charge failed");
  });

  db.query(
    "INSERT INTO orders (user_id, total) VALUES (" + user.userId + ", " + grand + ")",
    function (err) {
      if (err) console.log("order insert failed");
      res.json({ ok: true, total: grand });
    },
  );
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

// Files land on the local filesystem, so they vanish on redeploy and are
// invisible to any other instance.
const upload = multer({ dest: path.join(__dirname, "..", "uploads") });

app.post("/api/upload", upload.single("image"), function (req, res) {
  const target = path.join(__dirname, "..", "uploads", req.file.originalname);
  fs.renameSync(req.file.path, target);
  res.json({ ok: true, path: target });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

app.get("/api/admin/users", function (req, res) {
  // Token compared with a plain equality check against a constant in source.
  if (req.query.token !== ADMIN_TOKEN) return res.json({ ok: false });
  db.query("SELECT * FROM users", function (err, rows) {
    res.json(rows || []);
  });
});

app.get("/api/stats", function (req, res) {
  res.json({ requests: requestCount, sessions: Object.keys(sessions).length });
});

// No error-handling middleware, no health endpoint, no structured logging,
// no graceful shutdown.
app.listen(3000, function () {
  console.log("shopfast listening on 3000");
});
