import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_API_URL = "https://api.openai.com/v1/responses";

const INSTRUCCIONES = `Eres un transcriptor especializado en recetas médicas impresas y manuscritas.
Tu tarea es extraer exactamente lo visible, sin completar ni corregir datos por intuición.

Reglas obligatorias:
1. Revisa encabezado, cuerpo, sellos, firmas y observaciones.
2. Distingue nombre del medicamento, concentración, presentación, dosis, frecuencia, vía, duración e indicaciones.
3. Conserva abreviaturas médicas en transcripcion_literal y normaliza solo cuando sea inequívoco.
4. Si una palabra, número o fecha es dudosa, no inventes: usa null o texto vacío y agrega una advertencia precisa.
5. Para frecuencias, asigna momentos solo cuando la receta lo permita claramente:
   - mañana: 06:00–11:59
   - tarde: 12:00–17:59
   - noche: 18:00–23:59
   Para "cada 4/6/8/12 horas", conserva la frecuencia literal en indicaciones y asigna los momentos razonables sin sustituir el texto original.
6. confianza_global y confianza por medicamento son porcentajes entre 0 y 100.
7. requiere_revision debe ser true si hay cualquier dato clínicamente importante dudoso.
8. Esto es transcripción, no diagnóstico ni recomendación médica.`;

const ESQUEMA_RECETA = {
  type: "object",
  additionalProperties: false,
  required: [
    "medico",
    "paciente",
    "fecha",
    "medicamentos",
    "citas",
    "notas_generales",
    "transcripcion_literal",
    "confianza_global",
    "requiere_revision",
    "advertencias",
  ],
  properties: {
    medico: { type: ["string", "null"] },
    paciente: { type: ["string", "null"] },
    fecha: { type: ["string", "null"] },
    medicamentos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "nombre",
          "dosis",
          "momentos",
          "duracion_dias",
          "indicaciones",
          "frecuencia_literal",
          "via",
          "confianza",
          "requiere_revision",
        ],
        properties: {
          nombre: { type: "string" },
          dosis: { type: "string" },
          momentos: {
            type: "array",
            items: { type: "string", enum: ["manana", "tarde", "noche"] },
          },
          duracion_dias: { type: ["number", "null"] },
          indicaciones: { type: ["string", "null"] },
          frecuencia_literal: { type: ["string", "null"] },
          via: { type: ["string", "null"] },
          confianza: { type: "number", minimum: 0, maximum: 100 },
          requiere_revision: { type: "boolean" },
        },
      },
    },
    citas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["motivo", "fecha", "hora", "lugar"],
        properties: {
          motivo: { type: "string" },
          fecha: { type: ["string", "null"] },
          hora: { type: ["string", "null"] },
          lugar: { type: ["string", "null"] },
        },
      },
    },
    notas_generales: { type: ["string", "null"] },
    transcripcion_literal: { type: "string" },
    confianza_global: { type: "number", minimum: 0, maximum: 100 },
    requiere_revision: { type: "boolean" },
    advertencias: { type: "array", items: { type: "string" } },
  },
};

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

function mensajePublico(error) {
  if (error?.publicMessage) return error.publicMessage;
  const status = Number(error?.status || 500);
  const mensaje = String(error?.message || "").toLowerCase();
  if (status === 400) return "La imagen, el PDF o la solicitud enviada no es válida.";
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
    servicio: "plan-salud-server-openai-v8",
    modelo: MODEL,
    apiKeyConfigurada: Boolean(process.env.OPENAI_API_KEY),
    ocrMejorado: true,
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    proveedor: "OpenAI",
    modelo: MODEL,
    apiKeyConfigurada: Boolean(process.env.OPENAI_API_KEY),
    formatos: ["jpeg", "png", "webp", "gif", "pdf"],
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
        max_output_tokens: 2600,
        text: {
          format: {
            type: "json_schema",
            name: "receta_medica_estructurada",
            description: "Transcripción estructurada y verificable de una receta médica.",
            strict: true,
            schema: ESQUEMA_RECETA,
          },
        },
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Analiza la receta completa dos veces antes de responder. Transcribe primero literalmente y después estructura los datos. Marca cualquier ambigüedad para revisión humana.",
              },
              contenidoArchivo,
            ],
          },
        ],
      }),
    });

    const respuesta = await respuestaApi.json().catch(() => ({}));
    if (!respuestaApi.ok) {
      const error = new Error(
        respuesta?.error?.message || `OpenAI respondió HTTP ${respuestaApi.status}`,
      );
      error.status = respuestaApi.status;
      error.details = respuesta?.error;
      throw error;
    }

    const texto = extraerTexto(respuesta);
    if (!texto) throw new Error("OpenAI no devolvió contenido estructurado.");
    const parsed = JSON.parse(texto);

    if (!Array.isArray(parsed.medicamentos) || parsed.medicamentos.length === 0) {
      parsed.advertencias = [
        ...(parsed.advertencias || []),
        "No se identificaron medicamentos con suficiente claridad.",
      ];
      parsed.requiere_revision = true;
    }

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
  console.log(`Servidor OpenAI V8 ejecutándose en el puerto ${PORT}`);
  console.log(`Modelo configurado: ${MODEL}`);
  console.log(`OPENAI_API_KEY configurada: ${Boolean(process.env.OPENAI_API_KEY)}`);
});
