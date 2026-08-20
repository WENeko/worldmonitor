import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  
  let routePath = url.pathname.replace(/^\/api/, '');
  if (routePath === '' || routePath === '/') {
    return res.status(200).json({ status: 'ok' });
  }

  if (routePath === '/index' || routePath === '/index.ts') {
    return res.status(404).json({ error: 'Route introuvable' });
  }

  try {
    const routeModule = await import(`.${routePath}`);
    const routeHandler = routeModule.default || routeModule;

    if (typeof routeHandler === 'function') {
      return await routeHandler(req, res);
    }

    return res.status(500).json({ error: 'Handler invalide pour cette route' });
  } catch (error: any) {
    try {
      const indexModule = await import(`.${routePath}/index`);
      const indexHandler = indexModule.default || indexModule;

      if (typeof indexHandler === 'function') {
        return await indexHandler(req, res);
      }
    } catch {
      // Ignorer
    }

    console.error(`[API Router Error] Route introuvable : ${routePath}`, error?.message);
    return res.status(404).json({ error: 'Route non trouvée' });
  }
}
