// Runs the routing engine off the main thread so the UI never stalls.
import { CanalGraph } from './graph.js';

let graph = null;

async function load(base) {
  const [waterways, locks, facilities, services] = await Promise.all([
    fetch(base + 'data/waterways.geojson').then((r) => r.json()),
    fetch(base + 'data/locks.json').then((r) => r.json()),
    fetch(base + 'data/facilities.json').then((r) => r.json()),
    fetch(base + 'data/services.json').then((r) => r.json()).catch(() => []), // CRT facilities
  ]);
  graph = new CanalGraph().build(waterways, locks, facilities.concat(services));
  const c = graph.components();
  return { nodes: graph.nodes.length, edges: graph.edges.length, components: c.count };
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'init') {
      const stats = await load(payload.base);
      self.postMessage({ id, ok: true, result: stats });
    } else if (type === 'route') {
      if (!graph) throw new Error('graph not ready');
      const r = graph.routeThrough(payload.points);
      self.postMessage({ id, ok: true, result: r });
    } else if (type === 'lockgroups') {
      if (!graph) throw new Error('graph not ready');
      self.postMessage({ id, ok: true, result: { groups: graph.lockGroups(), all: graph.lockData || [] } });
    } else if (type === 'snap') {
      if (!graph) throw new Error('graph not ready');
      self.postMessage({ id, ok: true, result: graph.snap(payload.point) });
    } else if (type === 'services') {
      if (!graph) throw new Error('graph not ready');
      self.postMessage({ id, ok: true, result: graph.nearestServices(payload.point, payload.settings) });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
