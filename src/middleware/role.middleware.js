// role.middleware.js
// Assumes authRequired ne req.user.role set kiya hai

export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      const userRole = user.role;
      if (!userRole || !allowedRoles.includes(userRole)) {
        return res.status(403).json({ ok: false, error: "Forbidden: insufficient role" });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}
