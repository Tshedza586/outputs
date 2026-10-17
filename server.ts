import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, normalize, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

type Role = "customer" | "admin" | "staff";
type SessionUser = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
};
type JsonObject = Record<string, unknown>;
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = process.env.DATA_DIR || join(root, "data");
mkdirSync(dataDir, { recursive: true });
const database = new DatabaseSync(
  process.env.DATABASE_PATH || join(dataDir, "escape-villa.sqlite3"),
);
database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
database.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','admin','staff')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL, required_skill TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, reference TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES users(id), service_id INTEGER NOT NULL REFERENCES services(id), event_type TEXT NOT NULL DEFAULT '', event_date TEXT NOT NULL, start_time TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 60, venue TEXT NOT NULL, guests INTEGER, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Pending Payment', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, booking_id INTEGER UNIQUE NOT NULL REFERENCES bookings(id), amount REAL, status TEXT NOT NULL DEFAULT 'Pending', evidence_received INTEGER NOT NULL DEFAULT 0, rejection_reason TEXT, reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id), skills TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), staff_id INTEGER REFERENCES staff(id), name TEXT NOT NULL, required_skill TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Unassigned', notes TEXT NOT NULL DEFAULT '', UNIQUE(booking_id,name));
CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), customer_id INTEGER NOT NULL REFERENCES users(id), requested_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Pending', response TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, recipient_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enquiries(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`);
const initialServices = [
  [
    "Photography",
    "Professional maternity, birthday, graduation, corporate and brand photography shoots.",
  ],
  [
    "Videography",
    "Film and video shoots for occasions, brands and creative projects.",
  ],
  [
    "Event Planning",
    "Greek-inspired outdoor venue hire, décor and catering for baby showers, birthdays, graduation parties and year-end functions. Maximum 45 guests; rates depend on guest numbers.",
  ],
  ["Makeup", "Makeup, hair installation and styling by appointment."],
  [
    "Romantic Private Dinner",
    "A romantic private-dining setup with a three-course meal, arranged by appointment.",
  ],
];
for (const [name, description] of initialServices)
  database
    .prepare(
      "INSERT OR IGNORE INTO services(name,description,required_skill) VALUES(?,?,?)",
    )
    .run(name, description, name);
for (const [name, description] of initialServices)
  database
    .prepare("UPDATE services SET description=? WHERE name=?")
    .run(description, name);
database
  .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)")
  .run(
    "mission",
    "Our mission is to provide high-quality photography and event services that capture meaningful moments, create memorable experiences and deliver value to our clients.",
  );
database
  .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)")
  .run(
    "vision",
    "Our vision is to grow into a trusted and recognised creative services brand known for quality, professionalism, creativity and positive customer experiences.",
  );

const secret =
  process.env.ESCAPE_VILLA_SECRET ||
  "development-secret-change-before-deployment";
const now = (): string => new Date().toISOString();
const json = (res: ServerResponse, body: unknown, status = 200): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
};
async function readJson(req: IncomingMessage): Promise<JsonObject> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error("Request body is too large.");
  }
  try {
    return data ? (JSON.parse(data) as JsonObject) : {};
  } catch {
    throw new Error("Invalid JSON request.");
  }
}
const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};
const verifyPassword = (password: string, saved: string): boolean => {
  const [salt, hash] = saved.split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
function sessionCookie(userId: number): string {
  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
  const data = `${userId}.${expiry}`;
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  return `ev_session=${data}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
function currentUser(req: IncomingMessage): SessionUser | null {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("ev_session="))
    ?.slice("ev_session=".length);
  if (!cookie) return null;
  const [idText, expiry, signature] = cookie.split(".");
  if (!idText || !expiry || !signature || Number(expiry) < Date.now() / 1000)
    return null;
  const expected = createHmac("sha256", secret)
    .update(`${idText}.${expiry}`)
    .digest("hex");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return null;
  return (
    (database
      .prepare(
        "SELECT id,name,email,phone,role FROM users WHERE id=? AND active=1",
      )
      .get(Number(idText)) as SessionUser | undefined) || null
  );
}
function requireRole(
  req: IncomingMessage,
  res: ServerResponse,
  roles: Role[],
): SessionUser | null {
  const user = currentUser(req);
  if (!user) {
    json(res, { error: "Sign in required." }, 401);
    return null;
  }
  if (!roles.includes(user.role)) {
    json(res, { error: "Not authorised." }, 403);
    return null;
  }
  return user;
}
function login(
  req: IncomingMessage,
  res: ServerResponse,
  user: SessionUser,
): void {
  res.setHeader("Set-Cookie", sessionCookie(user.id));
  json(res, user);
}
function notify(userId: number, message: string): void {
  database
    .prepare(
      "INSERT INTO notifications(recipient_id,message,created_at) VALUES(?,?,?)",
    )
    .run(userId, message, now());
}
function assignTask(bookingId: number): void {
  const booking = database
    .prepare(
      "SELECT b.*,s.name AS service,s.required_skill FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=?",
    )
    .get(bookingId) as
    | {
        reference: string;
        event_date: string;
        start_time: string;
        service: string;
        required_skill: string;
      }
    | undefined;
  if (!booking) return;
  database
    .prepare(
      "INSERT OR IGNORE INTO tasks(booking_id,name,required_skill,due_at) VALUES(?,?,?,?)",
    )
    .run(
      bookingId,
      `${booking.service} · event delivery`,
      booking.required_skill,
      `${booking.event_date}T${booking.start_time}`,
    );
  const task = database
    .prepare("SELECT id,staff_id FROM tasks WHERE booking_id=?")
    .get(bookingId) as { id: number; staff_id: number | null };
  if (task.staff_id) return;
  const candidates = database
    .prepare(
      "SELECT st.id,st.user_id FROM staff st JOIN users u ON u.id=st.user_id WHERE u.active=1 AND lower(st.skills) LIKE lower(?) ORDER BY (SELECT COUNT(*) FROM tasks WHERE staff_id=st.id AND status NOT IN ('Completed','Cancelled'))",
    )
    .all(`%${booking.required_skill}%`) as Array<{
    id: number;
    user_id: number;
  }>;
  for (const staff of candidates) {
    const conflict = database
      .prepare(
        "SELECT 1 FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE t.staff_id=? AND b.event_date=? AND t.status NOT IN ('Completed','Cancelled')",
      )
      .get(staff.id, booking.event_date);
    if (conflict) continue;
    database
      .prepare("UPDATE tasks SET staff_id=?,status='Assigned' WHERE id=?")
      .run(staff.id, task.id);
    notify(
      staff.user_id,
      `New task assigned for booking ${booking.reference}.`,
    );
    database
      .prepare("UPDATE bookings SET status='Assigned' WHERE id=?")
      .run(bookingId);
    return;
  }
  for (const admin of database
    .prepare("SELECT id FROM users WHERE role='admin'")
    .all() as Array<{ id: number }>)
    notify(
      admin.id,
      `No qualified staff is available for ${booking.reference}. Manual assignment needed.`,
    );
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method || "GET";
  if (method === "GET" && path === "/api/me")
    return (json(res, currentUser(req)), true);
  if (method === "GET" && path === "/api/public") {
    const serviceRows = database
      .prepare(
        "SELECT id,name,description,required_skill FROM services WHERE active=1 ORDER BY id",
      )
      .all();
    const settings = Object.fromEntries(
      (
        database.prepare("SELECT key,value FROM settings").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((row) => [row.key, row.value]),
    );
    return (json(res, { services: serviceRows, settings }), true);
  }
  if (method === "POST" && path === "/api/register") {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const password = String(body.password || "");
    if (
      !name ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      password.length < 10 ||
      body.privacy !== true
    )
      return (
        json(
          res,
          {
            error:
              "Name, valid email, 10-character password and privacy acceptance are required.",
          },
          400,
        ),
        true
      );
    try {
      const result = database
        .prepare(
          "INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES(?,?,?,?,'customer',?)",
        )
        .run(
          name,
          email,
          String(body.phone || ""),
          hashPassword(password),
          now(),
        );
      login(
        req,
        res,
        database
          .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
          .get(Number(result.lastInsertRowid)) as SessionUser,
      );
    } catch {
      json(res, { error: "That email address is already registered." }, 409);
    }
    return true;
  }
  if (
    method === "POST" &&
    ["/api/login", "/api/admin/login", "/api/staff/login"].includes(path)
  ) {
    const body = await readJson(req);
    const user = database
      .prepare("SELECT * FROM users WHERE email=? AND active=1")
      .get(String(body.email || "").toLowerCase()) as
      | (SessionUser & { password_hash: string })
      | undefined;
    const required = path.includes("/admin/")
      ? "admin"
      : path.includes("/staff/")
        ? "staff"
        : undefined;
    if (
      !user ||
      !verifyPassword(String(body.password || ""), user.password_hash) ||
      (required && user.role !== required)
    )
      return (
        json(res, { error: "Email or password is incorrect." }, 401),
        true
      );
    login(req, res, user);
    return true;
  }
  if (method === "POST" && path === "/api/admin/setup") {
    const body = await readJson(req);
    const configured = process.env.ESCAPE_VILLA_SETUP_KEY;
    if (
      !configured ||
      body.setup_key !== configured ||
      Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'")
          .get()?.count,
      ) > 0
    )
      return (
        json(
          res,
          {
            error:
              "Setup is unavailable or the one-time setup key is incorrect.",
          },
          403,
        ),
        true
      );
    if (
      !String(body.name || "").trim() ||
      !/^\S+@\S+\.\S+$/.test(String(body.email || "")) ||
      String(body.password || "").length < 10
    )
      return (
        json(
          res,
          {
            error:
              "Enter a name, valid email and password of at least 10 characters.",
          },
          400,
        ),
        true
      );
    const result = database
      .prepare(
        "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,'admin',?)",
      )
      .run(
        String(body.name || "").trim(),
        String(body.email || "").toLowerCase(),
        hashPassword(String(body.password || "")),
        now(),
      );
    login(
      req,
      res,
      database
        .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
        .get(Number(result.lastInsertRowid)) as SessionUser,
    );
    return true;
  }
  if (method === "POST" && path === "/api/logout") {
    res.setHeader(
      "Set-Cookie",
      "ev_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    return (json(res, { ok: true }), true);
  }
  if (method === "POST" && path === "/api/contact") {
    const body = await readJson(req);
    const vals = ["name", "email", "phone", "subject", "message"].map((key) =>
      String(body[key] || "").trim(),
    );
    if (vals.some((value) => !value))
      return (json(res, { error: "Complete all contact fields." }, 400), true);
    database
      .prepare(
        "INSERT INTO enquiries(name,email,phone,subject,message,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(...vals, now());
    for (const admin of database
      .prepare("SELECT id FROM users WHERE role='admin'")
      .all() as Array<{ id: number }>)
      notify(admin.id, "A new contact enquiry has arrived.");
    return (json(res, { ok: true }), true);
  }
  if (method === "PATCH" && path === "/api/customer/profile") {
    const user = requireRole(req, res, ["customer"]);
    if (!user) return true;
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const currentPassword = String(body.current_password || "");
    const newPassword = String(body.new_password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email))
      return (
        json(res, { error: "Enter your name and a valid email address." }, 400),
        true
      );
    const duplicate = database
      .prepare("SELECT 1 FROM users WHERE email=? AND id<>?")
      .get(email, user.id);
    if (duplicate)
      return (
        json(res, { error: "That email address is already registered." }, 409),
        true
      );
    if (newPassword) {
      const saved = database
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(user.id) as { password_hash: string } | undefined;
      if (!saved || !verifyPassword(currentPassword, saved.password_hash))
        return (
          json(res, { error: "Your current password is incorrect." }, 401),
          true
        );
      if (newPassword.length < 10)
        return (
          json(res, { error: "Your new password must be at least 10 characters." }, 400),
          true
        );
    }
    try {
      database
        .prepare("UPDATE users SET name=?,email=?,phone=? WHERE id=?")
        .run(name, email, phone, user.id);
      if (newPassword)
        database
          .prepare("UPDATE users SET password_hash=? WHERE id=?")
          .run(hashPassword(newPassword), user.id);
    } catch {
      return (
        json(res, { error: "That email address is already registered." }, 409),
        true
      );
    }
    const updated = database
      .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
      .get(user.id) as SessionUser;
    return (json(res, updated), true);
  }
  if (method === "GET" && path === "/api/customer/bookings") {
    const user = requireRole(req, res, ["customer"]);
    if (!user) return true;
    return (
      json(
        res,
        database
          .prepare(
            "SELECT b.*,s.name AS service,p.status AS payment_status FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id WHERE b.customer_id=? ORDER BY event_date DESC",
          )
          .all(user.id),
      ),
      true
    );
  }
  if (method === "POST" && path === "/api/customer/bookings") {
    const user = requireRole(req, res, ["customer"]);
    if (!user) return true;
    const body = await readJson(req);
    const date = String(body.event_date || "");
    const time = String(body.start_time || "");
    const venue = String(body.venue || "").trim();
    const minutes = Math.max(
      30,
      Math.min(960, Number(body.duration_minutes) || 60),
    );
    const service = Number(body.service_id);
    const guestCount =
      body.guests === undefined || body.guests === null || body.guests === ""
        ? null
        : Number(body.guests);
    if (
      guestCount !== null &&
      (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 45)
    )
      return (
        json(res, { error: "Escape Villa can accommodate up to 45 guests." }, 400),
        true
      );
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < new Date().toISOString().slice(0, 10) ||
      !/^\d{2}:\d{2}$/.test(time) ||
      !venue
    )
      return (
        json(
          res,
          { error: "Choose a future date, valid time and venue." },
          400,
        ),
        true
      );
    const selected = database
      .prepare("SELECT id FROM services WHERE id=? AND active=1")
      .get(service);
    if (!selected)
      return (json(res, { error: "Choose an active service." }, 400), true);
    const end = new Date(`2000-01-01T${time}:00`);
    end.setMinutes(end.getMinutes() + minutes);
    const endText = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    const collision = database
      .prepare(
        "SELECT 1 FROM bookings WHERE event_date=? AND status NOT IN ('Cancelled','Declined') AND start_time < ? AND time(start_time,'+'||duration_minutes||' minutes') > ?",
      )
      .get(date, endText, time);
    if (collision)
      return (
        json(
          res,
          { error: "That time overlaps another booking request." },
          409,
        ),
        true
      );
    const reference = `EV-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
    const result = database
      .prepare(
        "INSERT INTO bookings(reference,customer_id,service_id,event_type,event_date,start_time,duration_minutes,venue,guests,details,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'Pending Payment',?)",
      )
      .run(
        reference,
        user.id,
        service,
        String(body.event_type || ""),
        date,
        time,
        minutes,
        venue,
        guestCount,
        String(body.details || ""),
        now(),
      );
    database
      .prepare("INSERT INTO payments(booking_id,status) VALUES(?,'Pending')")
      .run(Number(result.lastInsertRowid));
    return (
      json(res, { ok: true, reference, status: "Pending Payment" }, 201),
      true
    );
  }
  if (method === "GET" && path === "/api/admin/dashboard") {
    if (!requireRole(req, res, ["admin"])) return true;
    const bookings = database
      .prepare(
        "SELECT b.*,u.name AS customer,s.name AS service,p.status AS payment_status FROM bookings b JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id ORDER BY b.created_at DESC",
      )
      .all();
    const staff = database
      .prepare(
        "SELECT u.id,u.name,u.email FROM users u WHERE u.role='staff' AND u.active=1",
      )
      .all();
    return (json(res, { bookings, staff }), true);
  }
  if (method === "POST" && path === "/api/admin/staff") {
    if (!requireRole(req, res, ["admin"])) return true;
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const skills = String(body.skills || "").trim().slice(0, 500);
    const password = String(body.password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10)
      return (
        json(
          res,
          { error: "Enter a name, valid email and password of at least 10 characters." },
          400,
        ),
        true
      );
    try {
      database.exec("BEGIN IMMEDIATE");
      const result = database
        .prepare(
          "INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES(?,?,?,?,'staff',?)",
        )
        .run(name, email, phone, hashPassword(password), now());
      database
        .prepare("INSERT INTO staff(user_id,skills) VALUES(?,?)")
        .run(Number(result.lastInsertRowid), skills);
      database.exec("COMMIT");
      const staffUser = database
        .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
        .get(Number(result.lastInsertRowid)) as SessionUser;
      return (json(res, staffUser, 201), true);
    } catch (error) {
      database.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed: users.email"))
        return (
          json(res, { error: "That email address is already registered." }, 409),
          true
        );
      console.error(error);
      return (json(res, { error: "Could not create the staff account." }, 500), true);
    }
  }
  if (method === "GET" && path === "/api/admin/reports") {
    if (!requireRole(req, res, ["admin"])) return true;
    const period = url.searchParams.get("period") || "daily";
    const selected =
      url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    if (
      !["daily", "weekly", "monthly"].includes(period) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(selected) ||
      Number.isNaN(Date.parse(`${selected}T00:00:00Z`))
    )
      return (
        json(
          res,
          { error: "Choose daily, weekly or monthly and a valid date." },
          400,
        ),
        true
      );
    const anchor = new Date(`${selected}T00:00:00Z`);
    let startDate: Date;
    let endDate: Date;
    if (period === "daily") {
      startDate = anchor;
      endDate = new Date(anchor);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
    } else if (period === "weekly") {
      startDate = new Date(anchor);
      const back = (anchor.getUTCDay() + 6) % 7;
      startDate.setUTCDate(startDate.getUTCDate() - back);
      endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + 7);
    } else {
      startDate = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1),
      );
      endDate = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1),
      );
    }
    const from = startDate.toISOString().slice(0, 10);
    const until = endDate.toISOString().slice(0, 10);
    const bookings = database
      .prepare(
        "SELECT b.reference,b.event_date,b.start_time,b.event_type,b.venue,b.status,u.name AS customer,u.email,s.name AS service,p.status AS payment_status,p.amount AS paid_amount FROM bookings b JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id WHERE b.event_date>=? AND b.event_date<? ORDER BY b.event_date,b.start_time",
      )
      .all(from, until) as Array<Record<string, string | number | null>>;
    const byService = database
      .prepare(
        "SELECT s.name AS label,COUNT(*) AS count FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.event_date>=? AND b.event_date<? GROUP BY s.id ORDER BY count DESC",
      )
      .all(from, until);
    const byStatus = database
      .prepare(
        "SELECT status AS label,COUNT(*) AS count FROM bookings WHERE event_date>=? AND event_date<? GROUP BY status ORDER BY count DESC",
      )
      .all(from, until);
    const paymentStatuses = database
      .prepare(
        "SELECT p.status AS label,COUNT(*) AS count FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.event_date>=? AND b.event_date<? GROUP BY p.status ORDER BY count DESC",
      )
      .all(from, until);
    const tasks = database
      .prepare(
        "SELECT t.status AS label,COUNT(*) AS count FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE b.event_date>=? AND b.event_date<? GROUP BY t.status ORDER BY count DESC",
      )
      .all(from, until);
    const paid = database
      .prepare(
        "SELECT COALESCE(SUM(p.amount),0) AS amount FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.event_date>=? AND b.event_date<? AND p.status IN ('Deposit Paid','Partially Paid','Fully Paid')",
      )
      .get(from, until) as { amount: number };
    const summary = {
      totalBookings: bookings.length,
      confirmed: bookings.filter((b) =>
        ["Confirmed", "Assigned", "In Progress", "Completed"].includes(
          String(b.status),
        ),
      ).length,
      cancelled: bookings.filter((b) => b.status === "Cancelled").length,
      completedTasks: Number(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE b.event_date>=? AND b.event_date<? AND t.status='Completed'",
          )
          .get(from, until)?.count || 0,
      ),
      totalTasks: Number(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE b.event_date>=? AND b.event_date<?",
          )
          .get(from, until)?.count || 0,
      ),
      paymentAmount: Number(paid.amount || 0),
    };
    return (
      json(res, {
        period,
        selectedDate: selected,
        startDate: from,
        endDateExclusive: until,
        summary,
        byService,
        byStatus,
        paymentStatuses,
        tasks,
        bookings,
      }),
      true
    );
  }
  if (method === "GET" && path === "/api/staff/tasks") {
    const user = requireRole(req, res, ["staff"]);
    if (!user) return true;
    return (
      json(
        res,
        database
          .prepare(
            "SELECT t.*,b.reference,b.event_date,b.start_time,b.venue,s.name AS service FROM tasks t JOIN bookings b ON b.id=t.booking_id JOIN services s ON s.id=b.service_id JOIN staff st ON st.id=t.staff_id WHERE st.user_id=? ORDER BY t.due_at",
          )
          .all(user.id),
      ),
      true
    );
  }
  if (method === "PATCH" && path === "/api/staff/tasks") {
    const user = requireRole(req, res, ["staff"]);
    if (!user) return true;
    const body = await readJson(req);
    const status = String(body.status || "");
    if (!["In Progress", "Blocked", "Completed"].includes(status))
      return (json(res, { error: "Invalid task status." }, 400), true);
    const task = database
      .prepare(
        "SELECT t.id,t.booking_id FROM tasks t JOIN staff s ON s.id=t.staff_id WHERE t.id=? AND s.user_id=?",
      )
      .get(Number(body.task_id), user.id) as
      | { id: number; booking_id: number }
      | undefined;
    if (!task) return (json(res, { error: "Task not found." }, 404), true);
    database
      .prepare("UPDATE tasks SET status=?,notes=? WHERE id=?")
      .run(status, String(body.notes || ""), task.id);
    for (const admin of database
      .prepare("SELECT id FROM users WHERE role='admin'")
      .all() as Array<{ id: number }>)
      notify(admin.id, `Staff updated task ${task.id}: ${status}.`);
    return (json(res, { ok: true }), true);
  }
  if (method === "GET" && path === "/api/notifications") {
    const user = requireRole(req, res, ["customer", "admin", "staff"]);
    if (!user) return true;
    return (
      json(
        res,
        database
          .prepare(
            "SELECT * FROM notifications WHERE recipient_id=? ORDER BY id DESC LIMIT 50",
          )
          .all(user.id),
      ),
      true
    );
  }
  if (method === "GET" && path === "/api/admin/bookings") {
    if (!requireRole(req, res, ["admin"])) return true;
    return (
      json(
        res,
        database
          .prepare(
            "SELECT b.*,u.name AS customer,s.name AS service,p.status AS payment_status FROM bookings b JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id ORDER BY b.id DESC",
          )
          .all(),
      ),
      true
    );
  }
  if (method === "POST" && path === "/api/admin/payment-review") {
    const admin = requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const bookingId = Number(body.booking_id);
    const evidence = database
      .prepare("SELECT evidence_received FROM payments WHERE booking_id=?")
      .get(bookingId) as { evidence_received: number } | undefined;
    if (body.approve === true && !evidence?.evidence_received)
      return (
        json(
          res,
          { error: "Payment evidence must be recorded before approval." },
          400,
        ),
        true
      );
    database
      .prepare(
        "UPDATE payments SET status=?,rejection_reason=?,reviewed_at=? WHERE booking_id=?",
      )
      .run(
        body.approve === true ? "Deposit Paid" : "Rejected",
        body.approve === true
          ? null
          : String(body.reason || "Please submit corrected proof."),
        now(),
        bookingId,
      );
    const booking = database
      .prepare("SELECT customer_id FROM bookings WHERE id=?")
      .get(bookingId) as { customer_id: number } | undefined;
    if (!booking)
      return (json(res, { error: "Booking not found." }, 404), true);
    database
      .prepare("UPDATE bookings SET status=? WHERE id=?")
      .run(
        body.approve === true ? "Confirmed" : "Pending Verification",
        bookingId,
      );
    notify(
      booking.customer_id,
      body.approve === true
        ? "Payment approved; booking confirmed."
        : "Payment proof needs correction. Please resubmit.",
    );
    if (body.approve === true) assignTask(bookingId);
    return (json(res, { ok: true }), true);
  }
  if (path.startsWith("/api/")) {
    json(res, { error: "Not found." }, 404);
    return true;
  }
  return false;
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};
createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' https://images.unsplash.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    let asset =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    asset = normalize(asset);
    const file = join(publicDir, asset);
    const rel = relative(publicDir, file);
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      !existsSync(file)
    ) {
      const index = join(publicDir, "index.html");
      res.writeHead(200, { "Content-Type": mime[".html"] });
      res.end(readFileSync(index));
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
    });
    res.end(readFileSync(file));
  } catch (error) {
    console.error(error);
    if (!res.headersSent)
      json(res, { error: "Server error. Check input and try again." }, 500);
    else res.end();
  }
}).listen(Number(process.env.PORT || 8000), "0.0.0.0", () =>
  console.log(
    `Escape Villa ready at http://0.0.0.0:${process.env.PORT || 8000}`,
  ),
);
