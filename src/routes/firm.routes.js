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
  listFirmUsers,
  requestFirmAdmin,
  deleteFirmUser,
  listWorkspaces,
  switchWorkspace,
  listFirmMembers,
  leaveFirm
} from '../controllers/firm.controller.js';

const router = express.Router();

// Apply auth middleware to all routes
router.use(authRequired);

// Firm creation and management
router.post('/', createFirm);                           // POST /api/firms
router.get('/me', getMyFirm);                          // GET /api/firms/me

// Collaborative workspaces (personal + shared). Specific paths must be declared
// before the parameterized ':firmId' routes so they are not captured by them.
router.get('/workspaces', listWorkspaces);             // GET /api/firms/workspaces
router.post('/switch', switchWorkspace);               // POST /api/firms/switch

// Join code management
router.post('/join', joinFirmByCode);                  // POST /api/firms/join

// NEW: user → FIRM_ADMIN (pending) of their linked firm
router.post('/request-admin', requestFirmAdmin);

router.get('/:firmId', getFirmById);                   // GET /api/firms/:firmId
router.patch('/:firmId', updateFirm);                  // PATCH /api/firms/:firmId

router.post('/:firmId/join-code/rotate', rotateJoinCode);  // POST /api/firms/:firmId/join-code/rotate

// Firm members (any active member can view teammates)
router.get('/:firmId/members', listFirmMembers);       // GET /api/firms/:firmId/members
router.post('/:firmId/leave', leaveFirm);              // POST /api/firms/:firmId/leave

// Firm users (owner management)
router.get('/:firmId/users', listFirmUsers);           // GET /api/firms/:firmId/users
router.delete('/:firmId/users/:userId', deleteFirmUser);  // DELETE user

export default router;