import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import categoryRouter from "./routes/categoryRoutes.js";
import uploadRouter from "./routes/uploadRoutes.js";
import { ImageInputError } from "./utils/imageValidation.js";

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

const port = process.env.PORT || 3000;

app.get("/", (req: Request, res: Response) => {
  res.send("Server is Live!");
});

// API Routes
app.use("/api/categories", categoryRouter);
app.use("/api/upload", uploadRouter);

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (error instanceof ImageInputError) {
    res.status(400).json({ success: false, message: error.message });
    return;
  }
  next(error);
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
