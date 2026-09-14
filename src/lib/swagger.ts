import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

// En dev (ts-node-dev) on lit les .ts sources ; en prod (dist/) on lit les .js compilés.
// swagger-jsdoc utilise `glob`, qui attend des slashs, pas des antislashs Windows.
const ext = path.extname(__filename) === '.ts' ? 'ts' : 'js';
const routesGlob = path.join(__dirname, '..', 'routes', `*.${ext}`).split(path.sep).join('/');

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Mam Buudu API',
      version: '1.0.0',
      description: "API backend de l'application de généalogie Mam Buudu.",
    },
    servers: [
      { url: process.env.API_BASE_URL || 'http://localhost:3000', description: 'Serveur courant' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Inscription, connexion, gestion de compte' },
      { name: 'Personnes', description: "Membres de l'arbre généalogique" },
      { name: 'Unions', description: 'Unions et filiations' },
      { name: 'Stories', description: 'Souvenirs et publications familiales' },
      { name: 'Timeline', description: 'Événements familiaux chronologiques' },
      { name: 'Activity', description: "Historique d'activité de la famille" },
    ],
  },
  apis: [routesGlob],
});
