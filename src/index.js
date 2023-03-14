const express = require('express');
const Prometheus = require('prom-client');
const ResponseTime = require('response-time');

const {
  requestCountGenerator,
  requestDurationGenerator,
  requestLengthGenerator,
  responseLengthGenerator,
} = require('./metrics');

const { normalizeStatusCode, normalizePath } = require('./normalizers');

const expressPathParameterRegex = /:\w+(?:_\w+)*/;
const samplePercent = 100;

const { extractRoutes } = require('./express-utils');

const defaultOptions = {
  metricsPath: '/metrics',
  metricsApp: null,
  authenticate: null,
  collectDefaultMetrics: true,
  collectGCMetrics: false,
  collectAnyPaths: false, // opt-out
  // buckets for response time from 0.05s to 2.5s
  // these are arbitrary values since i dont know any better ¯\_(ツ)_/¯
  requestDurationBuckets: Prometheus.exponentialBuckets(0.05, 1.75, 8),
  requestLengthBuckets: [],
  responseLengthBuckets: [],
  extraMasks: [],
  customLabels: [],
  transformLabels: null,
  normalizeStatus: true,
  sampleRate: 1.0,
};

function createExpressPrometheusExporterMiddleware(userOptions = {}) {
  const options = { ...defaultOptions, ...userOptions };
  const originalLabels = ['route', 'method', 'status'];
  options.customLabels = new Set([...originalLabels, ...options.customLabels]);
  options.customLabels = [...options.customLabels];
  const { metricsPath, metricsApp, normalizeStatus, sampleRate } = options;
  const allowedRoutes = [];
  let isAllowedRoutesInitialized = false;
  let sampleCount = 0

  const app = express();
  app.disable('x-powered-by');

  const requestDuration = requestDurationGenerator(
    options.customLabels,
    options.requestDurationBuckets,
    options.prefix,
  );
  const requestCount = requestCountGenerator(
    options.customLabels,
    options.prefix,
  );
  const requestLength = requestLengthGenerator(
    options.customLabels,
    options.requestLengthBuckets,
    options.prefix,
  );
  const responseLength = responseLengthGenerator(
    options.customLabels,
    options.responseLengthBuckets,
    options.prefix,
  );

  /**
   * Check whether incoming request path is actually registered on express.
   * Reduce the sample size, since you don't want to record any fools who hits random API.
   * Trust me bro, it makes your Prometheus Cries.
   */
  const isPathAllowed = (method, path) => {
    if (allowedRoutes.length === 0) return false;
    return allowedRoutes.some(
      (route) => route.method === method && route.path === path,
    );
  };

  const initializeAllowedRoutes = (req) => {
    const normalizedAllowedRoutes = extractRoutes(req.app).map((route) => ({
      method: route.method,
      path: normalizePath(route.path, [
        ...options.extraMasks,
        expressPathParameterRegex,
      ]),
    }));

    allowedRoutes.push(...normalizedAllowedRoutes);

    isAllowedRoutesInitialized = true;
  };
  
  const isSampled = () => (sampleCount / samplePercent) <= sampleRate;

  /**
   * Corresponds to the R(equest rate), E(error rate), and D(uration of requests),
   * of the RED metrics.
   */
  const recordResponse = ResponseTime((req, res, time) => {
    const { originalUrl, method } = req;

    if (originalUrl === metricsPath) return;

    sampleCount = sampleCount === samplePercent ? 0 : sampleCount + 1;

    if (!isSampled()) return 

    // will replace ids from the route with `#val` placeholder this serves to
    // measure the same routes, e.g., /image/id1, and /image/id2, will be
    // treated as the same route
    const path = normalizePath(originalUrl, options.extraMasks);

    if (!options.collectAnyPaths) {
      // Initialize allowed routes
      if (!isAllowedRoutesInitialized) initializeAllowedRoutes(req);

      // Route is not on the express stack.
      if (!isPathAllowed(method, path)) return;
    }

    const status = normalizeStatus
      ? normalizeStatusCode(res.statusCode)
      : res.statusCode.toString();

    const labels = { route: path, method, status };

    if (typeof options.transformLabels === 'function') {
      options.transformLabels(labels, req, res);
    }
    requestCount.inc(labels);

    // observe normalizing to seconds
    requestDuration.observe(labels, time / 1000);

    // observe request length
    if (options.requestLengthBuckets.length) {
      const reqLength = req.get('Content-Length');
      if (reqLength) {
        requestLength.observe(labels, Number(reqLength));
      }
    }

    // observe response length
    if (options.responseLengthBuckets.length) {
      const resLength = res.get('Content-Length');
      if (resLength) {
        responseLength.observe(labels, Number(resLength));
      }
    }
  });

  if (options.collectDefaultMetrics) {
    // when this file is required, we will start to collect automatically
    // default metrics include common cpu and head usage metrics that can be
    // used to calculate saturation of the service
    Prometheus.collectDefaultMetrics({
      prefix: options.prefix,
    });
  }

  app.use(recordResponse);

  /**
   * Metrics route to be used by prometheus to scrape metrics
   */
  const routeApp = metricsApp || app;

  routeApp.get(metricsPath, async (req, res, next) => {
    if (typeof options.authenticate === 'function') {
      let result = null;
      try {
        result = await options.authenticate(req);
      } catch (err) {
        // treat errors as failures to authenticate
      }

      // the requester failed to authenticate, then return next, so we don't
      // hint at the existance of this route
      if (!result) {
        return next();
      }
    }

    res.set('Content-Type', Prometheus.register.contentType);
    return res.end(await Prometheus.register.metrics());
  });

  return app;
}

module.exports = createExpressPrometheusExporterMiddleware;
