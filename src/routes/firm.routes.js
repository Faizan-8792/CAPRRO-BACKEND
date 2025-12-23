// src/routes/firm.routes.js
import express from 'express';
import { authRequired } from '../middleware/auth.middleware.js';
import { 
  createFirm, 
  getMyFirm, 
  getFirmById,
  updateFirm, 
  rotateJoinCode, 
  joinFirmByCode, 
  listFirmUsers 
} from '../controllers/firm.controller.js';

const router = express.Router();

// Apply auth middleware to all routes
router.use(authRequired);

// Firm creation and management
router.post('/', createFirm);                           // POST /api/firms
router.get('/me', getMyFirm);                          // GET /api/firms/me
router.get('/:firmId', getFirmById);                   // GET /api/firms/:firmId
router.patch('/:firmId', updateFirm);                  // PATCH /api/firms/:firmId

// Join code management
router.post('/join', joinFirmByCode);                  // POST /api/firms/join
router.post('/:firmId/join-code/rotate', rotateJoinCode);  // POST /api/firms/:firmId/join-code/rotate

// Firm users
router.get('/:firmId/users', listFirmUsers);           // GET /api/firms/:firmId/users

export default router;
