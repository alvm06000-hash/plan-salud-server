import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_API_URL = "https://api.openai.com/v1/responses";

const INSTRUCCIONES = `Eres un asistente que transcribe recetas médicas a datos estructurados.
Devuelve ÚNICAMENTE un objeto JSON válido, sin markdown ni texto adicional, con esta forma exacta:
{
  "medico": "string o null",
  "paciente": "string o null",
  "fecha": "string o null",
  "medicamentos": [
    {
      "nombre": "string",
      "dosis": "string",
      "momentos": ["manana", "tarde", "noche"],
      "duracion_dias": "number o null",
      "indicaciones": "string o null"
    }
  ],
  "citas": [
    {
      "motivo": "string",
      "fecha": "string o null",
      "hora": "string o null",
      "lugar": "string o null"
    }
  ],
  "notas_generales": "string o null"
}
Si algún dato no aparece, usa null. No inventes medicamentos, dosis, frecuencias ni fechas.
Si la imagen no es una receta médica legible, devuelve {"error":"La receta no es suficientemente legible"}.
Esto es una transcripción; no des diagnóstico ni cambies indicaciones médicas.`;

function getApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY no está configurada en Railway");
    error.status = 503;
    error.publicMessage = "El servidor no tiene configurada la clave de OpenAI.";
    throw error;
  }
  return apiKey;
}

function extraerTexto(respuesta) {
  if (typeof respuesta?.output_text === "string" && respuesta.output_text.trim()) {
    return respuesta.output_text.trim();
  }

  const partes = [];
  for (const item of respuesta?.output || []) {
    for (const contenido of item?.content || []) {
      if (contenido?.type === "output_text" && typeof contenido.text === "string") {
        partes.push(contenido.text);
      }
    }
  }
  return partes.join("\n").trim();
}

function extraerJson(texto) {
  if (!texto) throw new Error("OpenAI no devolvió texto");
  const limpio = texto
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(limpio);
  } catch {
    const inicio = limpio.indexOf("{");
    const fin = limpio.lastIndexOf("}");
    if (inicio >= 0 && fin > inicio) return JSON.parse(limpio.slice(inicio, fin + 1));
    throw new Error("OpenAI devolvió una respuesta que no es JSON válido");
  }
}

function mensajePublico(error) {
  if (error?.publicMessage) return error.publicMessage;
  const status = Number(error?.status || 500);
  const mensaje = String(error?.message || "").toLowerCase();

  if (status === 400) return "La imagen o la solicitud enviada no es válida.";
  if (status === 401) return "La clave API de OpenAI es inválida o fue revocada.";
  if (status === 402 || mensaje.includes("billing") || mensaje.includes("quota") || mensaje.includes("credit")) {
    return "La cuenta de OpenAI no tiene saldo disponible o alcanzó su cuota.";
  }
  if (status === 403) return "La cuenta no tiene permiso para usar el modelo configurado.";
  if (status === 404) return `El modelo ${MODEL} no está disponible para esta cuenta.`;
  if (status === 413) return "El archivo es demasiado grande.";
  if (status === 429) return "Se alcanzó temporalmente el límite de uso de OpenAI o no hay cuota disponible.";
  if (status >= 500) return "OpenAI está temporalmente no disponible.";
  return "No se pudo procesar la receta.";
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    servicio: "plan-salud-server-openai",
    modelo: MODEL,
    apiKeyConfigurada: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    proveedor: "OpenAI",
    modelo: MODEL,
    apiKeyConfigurada: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.post("/api/leer-receta", async (req, res) => {
  try {
    const {
      imagen,
      mediaType = "image/jpeg",
      nombreArchivo = mediaType === "application/pdf" ? "receta.pdf" : "receta.jpg",
    } = req.body || {};

    if (!imagen || typeof imagen !== "string") {
      return res.status(400).json({ error: "Falta el archivo de la receta." });
    }

    const tiposPermitidos = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "application/pdf",
    ]);

    if (!tiposPermitidos.has(mediaType)) {
      return res.status(400).json({
        error: "Formato no compatible. Usa JPG, PNG, WEBP, GIF o PDF.",
      });
    }

    const esPdf = mediaType === "application/pdf";
    const contenidoArchivo = esPdf
      ? {
          type: "input_file",
          filename: nombreArchivo || "receta.pdf",
          file_data: `data:application/pdf;base64,${imagen}`,
        }
      : {
          type: "input_image",
          image_url: `data:${mediaType};base64,${imagen}`,
          detail: "high",
        };

    console.log(new Date().toISOString(), "POST /api/leer-receta", {
      mediaType,
      nombreArchivo,
      longitudBase64: imagen.length,
    });

    const respuestaApi = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: INSTRUCCIONES,
        temperature: 0,
        max_output_tokens: 1600,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Transcribe esta receta al JSON solicitado. Si una palabra no se distingue, indícalo en notas_generales y no inventes información.",
              },
              contenidoArchivo,
            ],
          },
        ],
      }),
    });

    const respuesta = await respuestaApi.json().catch(() => ({}));
    if (!respuestaApi.ok) {
      const error = new Error(respuesta?.error?.message || `OpenAI respondió HTTP ${respuestaApi.status}`);
      error.status = respuestaApi.status;
      error.details = respuesta?.error;
      throw error;
    }

    const parsed = extraerJson(extraerTexto(respuesta));
    return res.json(parsed);
  } catch (error) {
    const statusOriginal = Number(error?.status || 500);
    const statusRespuesta = statusOriginal >= 400 && statusOriginal <= 599 ? statusOriginal : 500;

    console.error("ERROR AL PROCESAR RECETA CON OPENAI:", {
      message: error?.message,
      status: error?.status,
      details: error?.details,
    });

    return res.status(statusRespuesta).json({ error: mensajePublico(error) });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor OpenAI ejecutándose en el puerto ${PORT}`);
  console.log(`Modelo configurado: ${MODEL}`);
  console.log(`OPENAI_API_KEY configurada: ${Boolean(process.env.OPENAI_API_KEY)}`);
});
