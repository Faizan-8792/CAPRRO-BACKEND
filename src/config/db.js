import mongoose from "mongoose";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000; // 5 seconds between retries

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI not set in .env");
  }

  mongoose.set("strictQuery", true);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(uri, {
        autoIndex: process.env.NODE_ENV !== "production", // Index in dev, manage in prod
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 15000,
        socketTimeoutMS: 45000,
        // Connection pool sized for production traffic
        maxPoolSize: Number(process.env.MONGO_POOL_MAX) || 50,
        minPoolSize: Number(process.env.MONGO_POOL_MIN) || 5,
        // How long an operation may wait for a FREE POOL CONNECTION before giving up.
        //
        // The driver's default is 0, meaning "wait forever". None of the timeouts above bound this:
        // serverSelectionTimeoutMS bounds choosing a server, socketTimeoutMS bounds an operation
        // that is already running. Neither applies while an operation is still QUEUED, waiting for
        // one of the maxPoolSize slots.
        //
        // So a saturated pool did not surface as errors. It surfaced as silence: every new
        // operation queued indefinitely - including the one /health awaits - so the process stayed
        // alive and listening while answering nothing. That is why an outage reads as
        // 504 Gateway Timeout rather than 502. Nothing was wrong with the process, and nothing was
        // visible in it either.
        //
        // 10s is longer than any healthy request waits, and short enough that saturation announces
        // itself as a handled error naming the pool instead of as a hang.
        waitQueueTimeoutMS: 10_000,
        // Query timeout — fail fast on slow queries
        maxIdleTimeMS: 60_000,
        retryWrites: true,
        retryReads: true,
        w: "majority",
      });

      // Listen for connection events
      mongoose.connection.on("error", (err) => {
        console.error("MongoDB connection error:", err.message);
      });
      mongoose.connection.on("disconnected", () => {
        console.warn("MongoDB disconnected — Mongoose will auto-reconnect");
      });
      mongoose.connection.on("reconnected", () => {
        console.log("MongoDB reconnected");
      });

      console.log("✅ MongoDB connected (pool:", process.env.MONGO_POOL_MAX || 50, ")");
      return;
    } catch (err) {
      console.error(
        `❌ MongoDB connection attempt ${attempt}/${MAX_RETRIES} failed:`,
        err.message
      );
      if (attempt < MAX_RETRIES) {
        console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw new Error(
          `MongoDB failed to connect after ${MAX_RETRIES} attempts: ${err.message}`
        );
      }
    }
  }
}

export default connectDB;
