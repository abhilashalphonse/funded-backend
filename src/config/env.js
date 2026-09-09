import "dotenv/config"; // SAFE fallback

const env = {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT || 3000,
  MONGODB_URI: process.env.MONGODB_URI,
  POSTGRES_URL: process.env.POSTGRES_URL,
  POSTGRES_HOST: process.env.POSTGRES_HOST,
  POSTGRES_PORT: process.env.POSTGRES_PORT,
  POSTGRES_USER: process.env.POSTGRES_USER,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
  POSTGRES_DATABASE: process.env.POSTGRES_DATABASE
};

export default env;