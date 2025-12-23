import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI not set in .env');
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    autoIndex: true
  });

  console.log('✅ MongoDB connected');
}

// ✅ default export so `import connectDB from ...` works
export default connectDB;
