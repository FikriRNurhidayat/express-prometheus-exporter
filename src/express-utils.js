// Stolen from https://github.com/labithiotis/express-list-routes#readme
const path = require('path');

function getPathFromRegex(regexp) {
  return regexp
    .toString()
    .replace('/^', '')
    .replace('?(?=\\/|$)/i', '')
    .replace(/\\\//g, '/');
}

function combineStacks(acc, stack) {
  if (stack.handle.stack) {
    const routerPath = getPathFromRegex(stack.regexp);
    return [
      ...acc,
      ...stack.handle.stack.map((st) => ({ routerPath, ...st })),
    ];
  }
  return [...acc, stack];
}

function getStacks(app) {
  /* eslint-disable no-underscore-dangle */

  // Express 3
  if (app.routes) {
    // convert to express 4
    return Object.keys(app.routes)
      .reduce((acc, method) => [...acc, ...app.routes[method]], [])
      .map((route) => ({ route: { stack: [route] } }));
  }

  // Express 4
  if (app._router && app._router.stack) {
    return app._router.stack.reduce(combineStacks, []);
  }

  // Express 4 Router
  if (app.stack) {
    return app.stack.reduce(combineStacks, []);
  }

  // Express 5
  // Somehow, it mads when we call app.router
  try {
    if (app.router && app.router.stack) {
      return app.router.stack.reduce(combineStacks, []);
    }
  } catch (err) {
    // Handle that error
  }

  return [];
}

module.exports = {
  extractRoutes(app) {
    // TODO: Fix this, since this is just a copy and paste.
    /* eslint-disable no-restricted-syntax */
    const stacks = getStacks(app);

    const routes = [];

    if (stacks) {
      for (const stack of stacks) {
        if (stack.route) {
          const routeLogged = {};
          for (const route of stack.route.stack) {
            const method = route.method ? route.method.toUpperCase() : null;
            if (!routeLogged[method] && method) {
              routes.push({
                method,
                path: path.resolve(
                  [
                    stack.routerPath,
                    stack.route.path,
                    route.path,
                  ]
                    .filter((s) => !!s)
                    .join(''),
                ),
              });

              routeLogged[method] = true;
            }
          }
        }
      }
    }

    return routes;
  },
};
