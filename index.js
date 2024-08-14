const fs = require("fs");
const cors = require("cors");
const path = require("path");
const sharp = require("sharp");
const morgan = require("morgan");
const multer = require("multer");
const express = require("express");
const { optimize } = require("svgo");
const { v4: uuid } = require("uuid");
const { Redis } = require("@upstash/redis");

require("dotenv").config({ path: "./.env" });

const app = express();

app.use(express.static("public"));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "public/temp");
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = uuid();
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const redis = Redis.fromEnv();

const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/jpg", "image/gif", "image/svg+xml"];

app.get("/", (req, res) => {
  res.send("Hello World from Webpix API");
});

app.get("/logs", async (req, res) => {
  const totalRequests = await redis.get("requests");
  const totalFilesTransformed = await redis.get("fileCount");
  return res.status(200).json({ totalRequests, totalFilesTransformed });
});

app.post("/convert", upload.array("images", 10), async (req, res) => {
  try {
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const invalidFiles = files.filter((file) => !ALLOWED_MIME_TYPES.includes(file.mimetype));
    if (invalidFiles.length > 0) {
      return res.status(400).json({
        error: `Unsupported file types: ${invalidFiles.map((file) => file.mimetype).join(", ")}`,
      });
    }

    const convertedFiles = await Promise.all(
      files.map(async (file) => {
        console.log(
          `Processing file: ${file.originalname}, type: ${file.mimetype}, size: ${file.size}`
        );

        let outputBuffer;
        let outputFormat;

        try {
          switch (file.mimetype) {
            case "image/jpeg":
            case "image/png":
              outputBuffer = await sharp(file.path).webp({ quality: 75 }).toBuffer();
              outputFormat = "webp";
              break;

            case "image/gif":
              outputBuffer = await sharp(file.path, { animated: true })
                .gif({ quality: 10 })
                .toBuffer();
              outputFormat = "gif";
              break;

            case "image/svg+xml":
              const svgData = fs.readFileSync(file.path, "utf8");
              const optimizedSvg = optimize(svgData, { path: file.path });
              outputBuffer = Buffer.from(optimizedSvg.data, "utf8");
              outputFormat = "svg";
              break;

            default:
              throw new Error(`Unsupported file type: ${file.mimetype}`);
          }
        } catch (error) {
          console.error(`Error processing file ${file.originalname}:`, error);
          throw error;
        } finally {
          fs.unlinkSync(file.path);
        }

        return {
          originalName: file.originalname,
          convertedName: `${uuid()}.${outputFormat}`,
          size: outputBuffer.length,
          convertedBuffer: outputBuffer.toString("base64"),
          mimeType: `image/${outputFormat}`,
        };
      })
    );

    await redis.incr("requests");
    await redis.incrby("fileCount", files.length);

    res.json({
      message: "Conversion successful",
      files: convertedFiles,
    });
  } catch (error) {
    console.error("Conversion error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(
    `Server running on port ${process.env.PORT} in '${process.env.NODE_ENV.toUpperCase()}' mode`
  );
});
