// server.js - v10.4 (Manejo de Cuota Gemini + Filtro de Eventos Futuros + Paginación Eventbrite)
// Este robot utiliza IA para analizar y reescribir la información de eventos.

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parseStringPromise } = require("xml2js");
const cheerio = require("cheerio");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.json()); // NECESARIO para que el chatbot pueda enviar JSON al backend

// --- CONFIGURACIÓN DE SECRETOS (se deben añadir en Render) ---
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const SCRAPE_SECRET_KEY = process.env.SCRAPE_SECRET_KEY;
const EVENTBRITE_API_TOKEN = process.env.EVENTBRITE_API_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// --- Configuración de Google Gemini AI ---
let geminiModel;
if (GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    console.log("IA Gemini inicializada con modelo gemini-2.0-flash.");
} else {
    console.warn("ADVERTENCIA: GEMINI_API_KEY no está configurada. La IA no se utilizará para el análisis.");
}

// --- Función de retardo para manejar cuotas de API ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const GEMINI_REQUEST_DELAY_MS = 4500; // Aproximadamente 4.5 segundos para 15 solicitudes/minuto (60/15 = 4 segundos, añadimos un buffer)

// --- LÓGICA GENÉRICA DE SCRAPING ---
const scrapeRssFeed = (feed) => {
    const events = [];
    if (!feed.rss.channel[0] || !feed.rss.channel[0].item) return events;
    feed.rss.channel[0].item.forEach(item => {
        try {
            const title = item.title?.[0] || '';
            const link = item.link?.[0] || '';
            const description = item.description?.[0].replace(/<[^>]*>?/gm, '') || '';
            const content = item['content:encoded'] ? item['content:encoded'][0] : '';
            const $ = cheerio.load(content);
            const imageUrl = $('img').attr('src');
            if (title && link) {
                events.push({ name: title, description: description.substring(0, 500) + '...', imageUrl, sourceUrl: link, rawDate: item.pubDate?.[0] });
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

const scrapeHtmlArticle = ($, baseURI) => {
    const events = [];
    $("article, .evento, .event-item, .activity-card, .post-card, .card, .columna, .noticia-item, .item-list").each((index, element) => {
        try {
            const titleElement = $(element).find("h1, h2, h3, .title, .nombre-evento, .card-title, .entry-title").first();
            const title = titleElement.text().trim();
            let url = titleElement.find("a").attr("href") || $(element).find("a").first().attr("href");
            const description = $(element).find("p, .description, .bajada, .card-text, .entry-summary").first().text().trim();
            let imageUrl = $(element).find("img").attr('src');

            if (url && !url.startsWith('http')) url = new URL(url, baseURI).href;
            if (imageUrl && !imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, baseURI).href;

            if (title.toLowerCase().includes("buscador bn") || title.toLowerCase().includes("ver más") || 
                title.toLowerCase().includes("noticia") || title.toLowerCase().includes("comunicado") ||
                title.toLowerCase().includes("balance municipal") ||
                description.length < 30 && title.length < 20 
               ) {
                return;
            }

            if (title && url) {
                events.push({ name: title, description: description.substring(0, 500) + '...', imageUrl, sourceUrl: url });
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

const scrapeEventbriteApi = (apiResponse) => {
    const events = [];
    const eventList = apiResponse.events || apiResponse.data?.events;
    
    if (!eventList || !Array.isArray(eventList)) {
        console.warn("[Eventbrite] La respuesta de la API no contiene un array 'events' o no es un array.", apiResponse);
        return events;
    }

    eventList.forEach(event => {
        try {
            const name = event.name?.text || '';
            const description = event.summary || event.description?.text || '';
            const imageUrl = event.logo ? event.logo.original.url : null;
            const sourceUrl = event.url || '';
            const location = event.venue?.address?.localized_address_display || 'Online o por confirmar';
            const rawDate = event.start?.local ? new Date(event.start.local).toISOString() : null;

            if (name && sourceUrl) {
                events.push({ name, description, imageUrl, sourceUrl, location, rawDate });
            }
        } catch(e) { 
            console.error("Error al procesar un evento de Eventbrite:", e.message, event);
        }
    });
    return events;
};

// --- FUNCIÓN DE ANÁLISIS Y REESCRITURA CON IA (GEMINI) ---
async function processWithAI(eventData) {
    if (!geminiModel) {
        console.warn("[IA Gemini] Modelo no inicializado. Saltando análisis con IA.");
        return { isEvent: false }; 
    }

    const prompt = `Analiza el siguiente contenido que podría ser un evento público y accionable en Chile.
Para que sea un evento válido, DEBE ser una actividad a la que una persona pueda asistir, participar o ver (no una noticia, un comunicado de prensa, un artículo, un llamado a la acción genérico, una reapertura de instalaciones, una demolición, un balance municipal, un concurso o un programa continuo).

Si el contenido describe un EVENTO VÁLIDO, y si tiene una FECHA o un PERÍODO CLARO y una UBICACIÓN (física o 'Online') CLARA, extrae la siguiente información.

Si NO es un evento válido, o si no cumple con los criterios de FECHA/UBICACIÓN CLARA o no se puede extraer la información clave, responde SOLAMENTE con un JSON: {"isEvent": false}.

Si es un evento válido, responde SOLAMENTE con un JSON en este formato:
{
  "isEvent": true,
  "name": "Nombre conciso y atractivo del evento (ej. Concierto de Jazz, Exposición de Arte). Máximo 80 caracteres.",
  "description": "Descripción breve y clara del evento, explicando qué es y por qué es interesante. Máximo 150 caracteres. Evita frases como 'click aquí', 'más información', 'lee el artículo completo'.",
  "location": "Ubicación específica del evento (ej. 'Parque O'Higgins, Santiago', 'Online', 'Teatro Municipal de Valparaíso'). SIEMPRE debe ser un lugar físico o 'Online'. Si es un lugar muy genérico como solo 'Santiago' o 'Nacional', intenta ser más específico. Si no hay ubicación clara, pon 'Por confirmar'.",
  "date": "Fecha del evento en formato AAAA-MM-DD (ej. '2025-08-15'). Si es un rango de fechas, pon la fecha de inicio. Si no hay fecha clara o es evento continuo, pon 'Sin fecha'.",
  "budget": 0 | 10 | 20 | 30 | 40 | 50 | 51, // 0 para Gratis, -1 para precio desconocido, 10 para <=10 USD, 20 para <=20 USD, etc., 51 para >50 USD.
  "planType": "solo" | "pareja" | "grupo" | "familiar" | "cualquiera", // Cómo se disfruta mejor el evento
  "sourceUrl": "URL original del evento"
}

Contenido a analizar:
Nombre Original: ${eventData.name || 'No especificado'}
Descripción Original: ${eventData.description || 'No especificado'}
URL Original: ${eventData.sourceUrl || 'No especificado'}
Ubicación Original (si aplica): ${eventData.location || 'No especificado'}
Fecha Original (si aplica): ${eventData.rawDate || 'No especificado'}
`;

    try {
        await sleep(GEMINI_REQUEST_DELAY_MS); // <-- AÑADIDO: Pausa antes de cada llamada a la IA
        const result = await geminiModel.generateContent(prompt);
        const responseText = result.response.text();
        console.log(`[IA Gemini] Respuesta cruda para "${eventData.name.substring(0, 30)}...": ${responseText.substring(0, 200)}...`);

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const jsonString = jsonMatch[0];
            const parsedResult = JSON.parse(jsonString);

            if (parsedResult.isEvent) {
                parsedResult.name = (parsedResult.name && parsedResult.name.length <= 80) ? parsedResult.name : eventData.name?.substring(0,80) || 'Evento sin título';
                parsedResult.description = (parsedResult.description && parsedResult.description.length <= 150) ? parsedResult.description : eventData.description?.substring(0,150) || 'Sin descripción.';
                parsedResult.location = parsedResult.location || eventData.location || 'Por confirmar';
                parsedResult.date = parsedResult.date || 'Sin fecha';
                parsedResult.budget = parsedResult.budget !== undefined ? parsedResult.budget : -1;
                parsedResult.planType = parsedResult.planType || 'cualquiera';
                parsedResult.sourceUrl = parsedResult.sourceUrl || eventData.sourceUrl;
                
                return parsedResult;
            }
        }
        return { isEvent: false };
    } catch (aiError) {
        console.error(`[IA Gemini] Error al llamar o parsear IA para "${eventData.name}":`, aiError.message);
        // Si el error es por cuota, lo logueamos y retornamos false, pero no se rompe el proceso
        if (aiError.message.includes('429 Too Many Requests')) {
            console.warn(`[IA Gemini] Límite de cuota excedido para "${eventData.name}". Intentando de nuevo en la próxima ejecución.`);
        }
        return { isEvent: false };
    }
}

// --- LISTA DE FUENTES PROPORCIONADA POR EL USUARIO (Optimizada) ---
const sources = [
    // API
    { name: "Eventbrite (API)", type: "api", city: "Santiago", scrape: scrapeEventbriteApi }, 
    // Fuente HTML de Eventbrite. Nota: Es probable que no capture muchos eventos debido a la carga dinámica de la web.
    { name: "Eventbrite (Web HTML)", type: "html", url: "https://www.eventbrite.cl/d/chile/events/", city: "Nacional", scrape: scrapeHtmlArticle },

    // Nivel 1 - Agregadores y Culturales Grandes (Alta probabilidad de eventos)
    { name: "PanoramasGratis.cl", type: "html", url: "https://panoramasgratis.cl/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "SantiagoCultura.cl", type: "html", url: "https://www.santiagocultura.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "ValpoCultura.cl", type: "html", url: "https://valpocultura.cl/", city: "Valparaíso", scrape: scrapeHtmlArticle },
    { name: "ConcepciónCultural.cl", type: "html", url: "https://www.concepcioncultural.cl/", city: "Concepción", scrape: scrapeHtmlArticle },
    { name: "TodoEnConce.cl", type: "html", url: "https://www.todoenconce.cl/", city: "Concepción", scrape: scrapeHtmlArticle },
    { name: "Día de los Patrimonios", type: "html", url: "https://www.diadelospatrimonios.cl/", city: "Nacional", scrape: scrapeHtmlArticle }, 
    { name: "Centro Gabriela Mistral (GAM)", type: "html", url: "https://gam.cl/cartelera/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Centro Cultural La Moneda", type: "html", url: "https://www.cclm.cl/actividades/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Teatro Municipal de Santiago", type: "html", url: "https://municipal.cl/cartelera", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Corp. Cultural Las Condes", type: "html", url: "https://www.culturallascondes.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Cultura Providencia", type: "html", url: "https://culturaprovidencia.cl/", city: "Santiago", scrape: scrapeHtmlArticle },

    // Nivel 2 - Museos y Universidades (A menudo con agenda cultural)
    { name: "Biblioteca Nacional", type: "html", url: "https://www.bibliotecanacional.gob.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Biblioteca de Santiago", type: "html", url: "https://www.bibliotecasantiago.gob.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Universidad de Chile (Agenda)", type: "html", url: "https://uchile.cl/agenda", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "USACH (Agenda)", type: "html", url: "https://www.usach.cl/agenda-usach", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Planetario USACH", type: "html", url: "https://planetariochile.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo Nacional de Historia Natural", type: "html", url: "https://www.mnhn.gob.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo de la Memoria y DD.HH.", type: "html", url: "https://museodelamemoria.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo Chileno de Arte Precolombino", type: "html", url: "https://museo.precolombino.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo Artequin", type: "html", url: "https://artequin.cl/", city: "Santiago", scrape: scrapeHtmlArticle },

    // Nivel 3 - Especializados
    { name: "Cineteca Nacional de Chile", type: "html", url: "https://www.cclm.cl/cineteca-nacional-de-chile/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "CineChile.cl", type: "html", url: "https://cinechile.cl/cartelera/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "Retina Latina", type: "html", url: "https://www.retinalatina.org/", city: "Nacional", scrape: scrapeHtmlArticle }, 
    { name: "Testing en Chile", type: "html", url: "https://www.testingenchile.cl/", city: "Santiago", scrape: scrapeHtmlArticle }, 
    { name: "Congreso Futuro", type: "html", url: "https://congresofuturo.cl/", city: "Nacional", scrape: scrapeHtmlArticle }, 
    { name: "Bicineta.cl", type: "html", url: "https://www.bicineta.cl/eventos", city: "Nacional", scrape: scrapeHtmlArticle }, 
    { name: "IBBY Chile", type: "html", url: "https://www.ibbychile.cl/", city: "Santiago", scrape: scrapeHtmlArticle }, 
    { name: "Calavera Lectora", type: "html", url: "https://calaveralectora.org/", city: "Nacional", scrape: scrapeHtmlArticle }, 
    { name: "Bandsintown", type: "html", url: "https://www.bandsintown.com/es/c/chile", city: "Nacional", scrape: scrapeHtmlArticle }, 

    // Nivel 4 - RSS Feeds
    { name: "Santiago Secreto (RSS)", type: "rss", url: "https://santiagosecreto.com/feed/", city: "Santiago", scrape: scrapeRssFeed },
    { name: "La Tercera Finde (RSS)", type: "rss", url: "https://www.latercera.com/finde/feed/", city: "Nacional", scrape: scrapeRssFeed },
    { name: "Chilevisión Panoramas (RSS)", type: "rss", url: "https://www.chilevision.cl/tag/panoramas-gratis/feed", city: "Nacional", scrape: scrapeRssFeed },
    { name: "Chile es Tuyo (RSS)", type: "rss", url: "https://chileestuyo.cl/feed/", city: "Nacional", scrape: scrapeRssFeed },
    { name: "El Mostrador Cultura (RSS)", type: "rss", url: "https://www.elmostrador.cl/cultura/feed/", city: "Nacional", scrape: scrapeRssFeed },
    { name: "Diario Concepción Cultura (RSS)", type: "rss", url: "https://www.diarioconcepcion.cl/cultura/feed/", city: "Concepción", scrape: scrapeRssFeed },
    
    // Nivel 5 - Municipalidades principales con sección de cultura/agenda
    { name: "Municipalidad de Antofagasta", type: "html", url: "https://www.municipalidadantofagasta.cl/cultura/", city: "Antofagasta", scrape: scrapeHtmlArticle }, 
    { name: "Municipalidad de La Serena", type: "html", url: "https://www.laserena.cl/agenda/", city: "La Serena", scrape: scrapeHtmlArticle }, 
    { name: "Municipalidad de Coquimbo", type: "html", url: "https://www.municoquimbo.cl/cultura/", city: "Coquimbo", scrape: scrapeHtmlArticle }, 
    { name: "Municipalidad de Viña del Mar", type: "html", url: "https://www.munivina.cl/agenda/", city: "Viña del Mar", scrape: scrapeHtmlArticle }, 
    { name: "Municipalidad de Puerto Montt", type: "html", url: "https://www.puertomontt.cl/cultura/", city: "Puerto Montt", scrape: scrapeHtmlArticle }, 
];

// Límite de páginas para la paginación de Eventbrite para evitar llamadas excesivas
const MAX_EVENTBRITE_PAGES = 5; 

async function fetchAllEvents() {
    let allEvents = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Establecer la hora a medianoche para comparar solo la fecha

    const fetchPromises = sources.map(async (source) => {
        try {
            let items = [];
            if (source.type === 'api') {
                if (!EVENTBRITE_API_TOKEN) {
                    console.error(`[${source.name}] EVENTBRITE_API_TOKEN no está configurado.`);
                    return;
                }
                
                let currentPage = 1;
                let hasMorePages = true;
                
                while (hasMorePages && currentPage <= MAX_EVENTBRITE_PAGES) {
                    const apiUrl = `https://www.eventbriteapi.com/v3/events/search/?location.address=${encodeURIComponent(source.city)}%2C+Chile&price=free&page_size=50&page=${currentPage}&token=${EVENTBRITE_API_TOKEN}`;
                    console.log(`[${source.name}] Intentando buscar en URL (página ${currentPage}): ${apiUrl}`);
                    try {
                        const { data } = await axios.get(apiUrl, { 
                            headers: { 
                                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                                'Accept': 'application/json' 
                            }, 
                            timeout: 15000 
                        });
                        console.log(`[${source.name}] Respuesta cruda (página ${currentPage}, primeros 500 chars): ${JSON.stringify(data).substring(0, 500)}...`);
                        
                        const newItems = source.scrape(data);
                        items = items.concat(newItems);
                        console.log(`[${source.name}] Página ${currentPage} extrajo ${newItems.length} ítems. Total hasta ahora: ${items.length}`);

                        // Verificar si hay más páginas según la API de Eventbrite
                        hasMorePages = data.pagination && data.pagination.has_more_items;
                        currentPage++;

                    } catch (apiError) {
                        console.error(`[${source.name}] Error en la llamada API para ${source.city} (página ${currentPage}):`, apiError.message);
                        if (apiError.response) {
                            console.error(`[${source.name}] Status: ${apiError.response.status}, Data: ${JSON.stringify(apiError.response.data)}`);
                        }
                        hasMorePages = false; // Detener paginación si hay un error
                    }
                }
                console.log(`[${source.name}] Paginación completada. Total de ítems brutos extraídos (antes de IA): ${items.length}`);

            } else { // HTML o RSS
                console.log(`[${source.name}] Intentando buscar en: ${source.url}`);
                const { data } = await axios.get(source.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                if (source.type === 'rss') {
                    items = scrapeRssFeed({ rss: { channel: [{ item: await parseStringPromise(data).then(p => p.rss.channel[0].item) }] } });
                } else { // html
                    items = scrapeHtmlArticle(cheerio.load(data), source.url);
                }
                console.log(`[${source.name}] Items brutos extraídos (antes de IA): ${items.length}`);
            }

            // --- PROCESAMIENTO CON IA Y FILTRO DE FECHA FUTURA ---
            for (const item of items) {
                let isFutureEvent = true;
                if (item.rawDate) {
                    const eventDate = new Date(item.rawDate);
                    eventDate.setHours(0, 0, 0, 0); // Normalizar a medianoche para comparación
                    if (eventDate < today) {
                        isFutureEvent = false;
                        console.log(`[Filtro Fecha] Evento descartado por ser pasado (${source.name}): "${item.name.substring(0, 50)}..." (Fecha: ${item.rawDate})`);
                    }
                }

                if (isFutureEvent) {
                    const eventDataForAI = {
                        name: item.name,
                        description: item.description,
                        sourceUrl: item.sourceUrl,
                        imageUrl: item.imageUrl,
                        location: item.location || source.city,
                        rawDate: item.rawDate
                    };

                    const aiProcessedResult = await processWithAI(eventDataForAI);

                    if (aiProcessedResult && aiProcessedResult.isEvent) {
                        allEvents.push({
                            name: aiProcessedResult.name,
                            description: aiProcessedResult.description,
                            imageUrl: item.imageUrl, 
                            sourceUrl: aiProcessedResult.sourceUrl,
                            city: aiProcessedResult.location, 
                            planType: aiProcessedResult.planType,
                            budget: aiProcessedResult.budget,
                            location: aiProcessedResult.location, 
                            date: aiProcessedResult.date
                        });
                    } else {
                        console.log(`[IA Gemini] Evento descartado por IA o no procesado (${source.name}): "${item.name.substring(0, 50)}..."`);
                    }
                }
            }
        } catch (error) { 
            console.error(`Error general al procesar la fuente ${source.name} (${source.url || 'API'}):`, error.message);
            if (error.response) {
                console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
            }
        }
    });

    await Promise.allSettled(fetchPromises);
    return allEvents;
}

// --- API ENDPOINTS ---
app.get("/", (req, res) => res.send("Motor de Eventis v10.4 funcionando (Manejo de Cuota Gemini + Filtro de Eventos Futuros + Paginación Eventbrite)."));

app.get("/events", async (req, res) => {
    if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
        return res.status(500).json({ error: "El servidor no está configurado correctamente (JSONBin API Key/ID faltantes)." });
    }
    try {
        const response = await axios.get(`${JSONBIN_URL}/latest`, { headers: { 'X-Master-Key': JSONBIN_API_KEY } });
        res.json(response.data.record.events);
    } catch (error) {
        console.error("Error al obtener eventos de JSONBin:", error.message);
        res.status(500).json({ error: "No se pudo obtener la lista de eventos de la bodega." });
    }
});

app.get("/run-scrape", async (req, res) => {
    const { key } = req.query;
    if (key !== SCRAPE_SECRET_KEY) {
        return res.status(401).send("Clave secreta inválida. Acceso no autorizado.");
    }
    
    console.log("Scraping activado...");
    const events = await fetchAllEvents();
    console.log(`Análisis completo. Se encontraron ${events.length} eventos de calidad (post-IA).`);

    try {
        const eventsToStore = events.map(({ imageUrl, ...rest }) => rest);
        await axios.put(JSONBIN_URL, { events: eventsToStore }, {
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY }
        });
        res.status(200).send(`Scraping completado. ${events.length} eventos de calidad guardados en JSONBin.`);
    } catch (error) {
        console.error("Error al guardar los eventos en la bodega JSONBin:", error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        }
        res.status(500).send("Error al guardar los eventos en la bodega. Revisa los logs.");
    }
});

// --- NUEVO ENDPOINT PARA EL CHATBOT DE IA ---
app.post("/recommend-event-ai", async (req, res) => {
    const { question, currentEvents } = req.body; 
    
    if (!geminiModel) {
        return res.status(500).json({ error: "El modelo de IA para el chatbot no está inicializado. Verifica GEMINI_API_KEY." });
    }

    try {
        const eventsContext = currentEvents && currentEvents.length > 0
            ? currentEvents.slice(0, 15).map(e => ({
                name: e.name,
                description: e.description,
                location: e.location,
                date: e.date,
                budget: e.budget === 0 ? 'Gratis' : (e.budget === -1 ? 'Precio no especificado' : `Hasta $${e.budget} USD`),
                planType: e.planType
              }))
            : [];

        const chatPrompt = `Eres un asistente amable, útil y conciso para recomendar eventos en Chile.
El usuario pregunta: "${question}".

Aquí tienes una lista de eventos disponibles que podrían ser relevantes para la recomendación del usuario (si la lista está vacía, no hay eventos específicos cargados en este momento):
${eventsContext.length > 0 ? JSON.stringify(eventsContext, null, 2) : 'No hay eventos específicos cargados en la lista actual. Puedes sugerirle al usuario que use los filtros de la página.'}

Basado en la pregunta del usuario y los eventos disponibles:
1. Si la pregunta es sobre un tipo de evento o característica (ej. "eventos gratis", "conciertos en Santiago", "planes para familia"), intenta recomendar 1-3 eventos *específicos* de la lista proporcionada. Si no hay ninguno que coincida, díselo amablemente.
2. Si la pregunta es muy general ("¿qué hay hoy?", "¿qué me recomiendas?"), sugiere que el usuario use los filtros de la página o que especifique más qué tipo de plan busca.
3. Si el usuario pregunta algo no relacionado con eventos, o algo que no puedes responder, díselo amablemente.
4. Mantén tus respuestas concisas (máx. 200 caracteres) y amigables. No inventes eventos que no estén en la lista. Si no puedes responder con los eventos dados, di que no encontraste un evento específico para su solicitud y sugiere usar los filtros o preguntar de otra manera.`;

        await sleep(GEMINI_REQUEST_DELAY_MS); // <-- AÑADIDO: Pausa antes de la llamada a la IA del chatbot también
        const result = await geminiModel.generateContent(chatPrompt);
        const responseText = result.response.text();
        res.json({ recommendation: responseText });

    } catch (error) {
        console.error("Error en el endpoint de recomendación de IA:", error);
        if (error.message.includes('429 Too Many Requests')) {
            console.warn(`[IA Gemini Chatbot] Límite de cuota excedido para el chatbot.`);
            res.status(429).json({ error: "Lo siento, el asistente está muy ocupado. Por favor, intenta de nuevo en un minuto." });
        } else {
            res.status(500).json({ error: "Lo siento, no se pudo generar una recomendación en este momento. Intenta de nuevo más tarde." });
        }
    }
});


const listener = app.listen(process.env.PORT || 3000, () => {
    console.log("Tu app Eventis v10.4 está escuchando en el puerto " + listener.address().port);
});
