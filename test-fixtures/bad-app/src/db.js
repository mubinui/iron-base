// Test fixture — deliberately bad. Do not copy this into a real project.
const mysql = require("mysql2");

// Credentials hardcoded in source, committed to the repo.
const connection = mysql.createConnection({
  host: "prod-db-01.shopfast.internal",
  user: "root",
  password: "Sup3rSecret!2019",
  database: "shopfast",
});

connection.connect(function (err) {
  if (err) {
    // Swallowed: the app keeps serving traffic against a dead connection.
    console.log("db connect problem");
  }
});

// A single shared connection, no pool — every request queues behind the last.
module.exports = connection;
