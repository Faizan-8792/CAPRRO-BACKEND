import jwt from 'jsonwebtoken';

export function signAccessToken(user) {
  const payload = {
    sub: user._id.toString(),
    email: user.email,
    accountType: user.accountType,
    firmId: user.firmId ? user.firmId.toString() : null,
    role: user.role
  };

  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';

  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyAccessToken(token) {
  const secret = process.env.JWT_SECRET;
  return jwt.verify(token, secret);
}
