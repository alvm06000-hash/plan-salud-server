// Backend mínimo (Node + Express) que recibe la imagen desde la app
// y llama a la API de Anthropic guardando la API key de forma segura.

import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SISTEMA = `Eres un asistente clínico que transcribe recetas médicas a datos estructurados.
Devuelve ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin markdown, sin backticks, con esta forma exacta:
{
  "medico": "string o null",
  "paciente": "string o null",
  "fecha": "string o null",
  "medicamentos": [
    {
      "nombre": "string",
      "dosis": "string",
      "momentos": ["manana","tarde","noche"],
      "duracion_dias": number o null,
      "indicaciones": "string o null"
    }
  ],
  "citas": [
    { "motivo": "string", "fecha": "string o null", "hora": "string o null", "lugar": "string o null" }
  ],
  "notas_generales": "string o null"
}
Si algún dato no aparece, usa null. Si la imagen no es una receta médica legible, devuelve {"error": "descripción breve"}.`;

app.post("/api/leer-receta", async (req, res) => {
  try {
    const { imagen, mediaType } = req.body;
    if (!imagen) return res.status(400).json({ error: "Falta la imagen" });

    const respuesta = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: SISTEMA,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imagen } },
            { type: "text", text: "Transcribe esta receta médica al JSON indicado." },
          ],
        },
      ],
    });

    const texto = respuesta.content.map((b) => b.text || "").join("\n");
    const limpio = texto.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(limpio);
    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo procesar la receta" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
