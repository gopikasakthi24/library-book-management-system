// server.js
// Run: npm init -y -> npm install express express-session -> node server.js
// Open: http://localhost:5000

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- Helpers to read/write JSON ----------
const DATA_DIR = path.join(__dirname, "data");
const FILES = {
  books: path.join(DATA_DIR, "books.json"),
  users: path.join(DATA_DIR, "users.json"),
  issued: path.join(DATA_DIR, "issued.json"),
  requests: path.join(DATA_DIR, "requests.json"),
};

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Ensure seed data ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

if (!fs.existsSync(FILES.users)) {
  writeJSON(FILES.users, [
    { id: 1, username: "admin", password: "admin123", role: "admin" },
    { id: 2, username: "student1", password: "stud123", role: "student" },
  ]);
}

if (!fs.existsSync(FILES.books)) {
  writeJSON(FILES.books, [
    { id: 1, title: "Clean Code", author: "Robert C. Martin", available: 3 },
    { id: 2, title: "Atomic Habits", author: "James Clear", available: 2 },
    { id: 3, title: "The Pragmatic Programmer", author: "Andrew Hunt", available: 1 },
  ]);
}

if (!fs.existsSync(FILES.issued)) writeJSON(FILES.issued, []);
if (!fs.existsSync(FILES.requests)) writeJSON(FILES.requests, []);

// ---------- Middleware ----------
app.use(express.json());
app.use(
  session({
    secret: "library-secret-xyz",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);
app.use(express.static(path.join(__dirname, "public")));

// ---------- Small auth helpers ----------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role)
      return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

// ---------- Auth ----------
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const users = readJSON(FILES.users);
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(400).json({ error: "Invalid credentials" });

  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ success: true, role: user.role });
});

app.post("/signup", (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !role)
    return res.status(400).json({ error: "Missing fields" });
  if (!["admin", "student"].includes(role))
    return res.status(400).json({ error: "Invalid role" });

  const users = readJSON(FILES.users);
  if (users.some(u => u.username === username))
    return res.status(400).json({ error: "Username exists" });

  const newUser = {
    id: users.length ? Math.max(...users.map(u => u.id)) + 1 : 1,
    username,
    password,
    role,
  };
  users.push(newUser);
  writeJSON(FILES.users, users);
  res.json({ success: true });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/whoami", (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- Books (public to logged-in users) ----------
app.get("/api/books", requireLogin, (req, res) => {
  const books = readJSON(FILES.books);
  res.json(books);
});

// ---------- Student APIs ----------
app.get("/api/mybooks", requireRole("student"), (req, res) => {
  const issued = readJSON(FILES.issued);
  const mine = issued.filter(
    i => i.username === req.session.user.username && !i.return_date
  );
  res.json(mine);
});

app.get("/api/myrequests", requireRole("student"), (req, res) => {
  const requests = readJSON(FILES.requests);
  const mine = requests.filter(
    r => r.username === req.session.user.username && r.status === "pending"
  );
  res.json(mine);
});

app.post("/api/request-borrow", requireRole("student"), (req, res) => {
  const { bookId } = req.body || {};
  if (!bookId) return res.status(400).json({ error: "bookId required" });

  const books = readJSON(FILES.books);
  const book = books.find(b => b.id === Number(bookId));
  if (!book) return res.status(404).json({ error: "Book not found" });
  if (book.available <= 0) return res.status(400).json({ error: "No copies available" });

  const requests = readJSON(FILES.requests);
  if (
    requests.some(
      r =>
        r.username === req.session.user.username &&
        r.bookId === book.id &&
        r.type === "borrow" &&
        r.status === "pending"
    )
  ) {
    return res.status(400).json({ error: "You already have a pending borrow request" });
  }

  const newReq = {
    id: requests.length ? Math.max(...requests.map(r => r.id)) + 1 : 1,
    type: "borrow",
    username: req.session.user.username,
    bookId: book.id,
    title: book.title,
    requested_at: new Date().toISOString(),
    status: "pending",
  };
  requests.push(newReq);
  writeJSON(FILES.requests, requests);
  res.json({ success: true });
});

app.post("/api/request-return", requireRole("student"), (req, res) => {
  const { bookId } = req.body || {};
  if (!bookId) return res.status(400).json({ error: "bookId required" });

  const issued = readJSON(FILES.issued);
  const open = issued.find(
    i => i.username === req.session.user.username && i.bookId === Number(bookId) && !i.return_date
  );
  if (!open) return res.status(400).json({ error: "No active issue for this book" });

  const requests = readJSON(FILES.requests);
  if (
    requests.some(
      r =>
        r.username === req.session.user.username &&
        r.bookId === Number(bookId) &&
        r.type === "return" &&
        r.status === "pending"
    )
  ) {
    return res.status(400).json({ error: "You already have a pending return request" });
  }

  const newReq = {
    id: requests.length ? Math.max(...requests.map(r => r.id)) + 1 : 1,
    type: "return",
    username: req.session.user.username,
    bookId: Number(bookId),
    title: open.title,
    requested_at: new Date().toISOString(),
    status: "pending",
  };
  requests.push(newReq);
  writeJSON(FILES.requests, requests);
  res.json({ success: true });
});

// ---------- Admin APIs ----------
app.post("/api/books", requireRole("admin"), (req, res) => {
  const { title, author, available } = req.body || {};
  if (!title || !author)
    return res.status(400).json({ error: "title & author required" });

  const books = readJSON(FILES.books);
  const newBook = {
    id: books.length ? Math.max(...books.map(b => b.id)) + 1 : 1,
    title,
    author,
    available: Math.max(0, Number(available || 1)),
  };
  books.push(newBook);
  writeJSON(FILES.books, books);
  res.json({ success: true, book: newBook });
});

app.delete("/api/books/:id", requireRole("admin"), (req, res) => {
  const bookId = Number(req.params.id);
  const issued = readJSON(FILES.issued);
  if (issued.some(i => i.bookId === bookId && !i.return_date)) {
    return res.status(400).json({ error: "Cannot delete: book has active issues" });
  }
  const books = readJSON(FILES.books);
  const next = books.filter(b => b.id !== bookId);
  writeJSON(FILES.books, next);
  res.json({ success: true });
});

app.get("/api/issued", requireRole("admin"), (req, res) => {
  const issued = readJSON(FILES.issued);
  res.json(issued);
});

app.get("/api/requests", requireRole("admin"), (req, res) => {
  const requests = readJSON(FILES.requests);
  res.json(requests.filter(r => r.status === "pending"));
});

app.post("/api/requests/approve", requireRole("admin"), (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId required" });

  const requests = readJSON(FILES.requests);
  const reqItem = requests.find(r => r.id === Number(requestId) && r.status === "pending");
  if (!reqItem) return res.status(404).json({ error: "Request not found" });

  const books = readJSON(FILES.books);
  const issued = readJSON(FILES.issued);
  const book = books.find(b => b.id === reqItem.bookId);

  if (reqItem.type === "borrow") {
    if (!book || book.available <= 0)
      return res.status(400).json({ error: "Book not available" });
    book.available -= 1;
    const issue = {
      id: issued.length ? Math.max(...issued.map(i => i.id)) + 1 : 1,
      username: reqItem.username,
      bookId: book.id,
      title: book.title,
      issue_date: today(),
      return_date: null,
    };
    issued.push(issue);
  } else if (reqItem.type === "return") {
    const open = issued.find(
      i => i.username === reqItem.username && i.bookId === reqItem.bookId && !i.return_date
    );
    if (!open) return res.status(400).json({ error: "No open issue found" });
    open.return_date = today();
    if (book) book.available += 1;
  }

  reqItem.status = "approved";
  writeJSON(FILES.requests, requests);
  writeJSON(FILES.books, books);
  writeJSON(FILES.issued, issued);
  res.json({ success: true });
});

app.post("/api/requests/reject", requireRole("admin"), (req, res) => {
  const { requestId } = req.body || {};
  const requests = readJSON(FILES.requests);
  const reqItem = requests.find(r => r.id === Number(requestId) && r.status === "pending");
  if (!reqItem) return res.status(404).json({ error: "Request not found" });

  reqItem.status = "rejected";
  writeJSON(FILES.requests, requests);
  res.json({ success: true });
});

// ---------- Pages ----------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "auth.html"))
);
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);
app.get("/student", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "student.html"))
);
app.get("/admin-dashboard", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin-dashboard.html"))
);

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
