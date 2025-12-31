import dotenv from "dotenv";
import connectDB from "./config/db.js";
import path from "path";
import { fileURLToPath } from "url";

import Reminder from "./models/Reminder.js";
import { processReminderForNow } from "./controllers/reminder.controller.js";
import app from "./app.js";

dotenv.config();

await connectDB();

const PORT = Number(process.env.PORT || 4001);

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, "../public")));

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// ----- SIMPLE SCHEDULER -----
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

async function runReminderScheduler() {
  const nowUtc = new Date();
  console.log("REMINDER Scheduler tick at", nowUtc.toISOString());

  try {
    const activeReminders = await Reminder.find({ isActive: true });

    for (const r of activeReminders) {
      try {
        await processReminderForNow(r, nowUtc);
      } catch (e) {
        console.error("REMINDER Error processing reminder", r?.id, e);
      }
    }
  } catch (err) {
    console.error("REMINDER Scheduler top-level error", err);
  }
}

setInterval(runReminderScheduler, SCHEDULER_INTERVAL_MS);
runReminderScheduler();

export default server;