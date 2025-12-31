import Task from "../models/Task.model.js";
import User from "../models/User.model.js";
import Firm from "../models/Firm.model.js";

// Helper to check if user can manage tasks for this firm
async function canManageFirmTasks(userId, firmId) {
  const user = await User.findById(userId);
  if (!user) return false;
  
  // Admin users can manage tasks for their firm
  return user.firmId.toString() === firmId.toString() && user.role === 'ADMIN';
}

// Create a new task (Admin only)
export const createTask = async (req, res) => {
  try {
    const { firmId } = req.user;
    
    // Only admin users in the firm can create tasks
    if (!(await canManageFirmTasks(req.user.id, firmId))) {
      return res.status(403).json({ 
        error: 'Only admin users can create tasks' 
      });
    }
    
    const { 
      clientName, 
      serviceType, 
      title, 
      dueDateISO, 
      assignedTo, 
      status = 'NOT_STARTED',
      meta = {}
    } = req.body;
    
    // Validate required fields
    if (!clientName || !serviceType || !title || !dueDateISO) {
      return res.status(400).json({ 
        error: 'Missing required fields: clientName, serviceType, title, dueDateISO' 
      });
    }
    
    // Validate due date
    const dueDate = new Date(dueDateISO);
    if (isNaN(dueDate.getTime())) {
      return res.status(400).json({ 
        error: 'Invalid due date format' 
      });
    }
    
    // Check if assignedTo user exists and belongs to the same firm
    let assignedUser = null;
    if (assignedTo) {
      assignedUser = await User.findOne({
        _id: assignedTo,
        firmId
      });
      
      if (!assignedUser) {
        return res.status(400).json({ 
          error: 'Assigned user not found or does not belong to your firm' 
        });
      }
    }
    
    const task = new Task({
      firmId,
      clientName,
      serviceType,
      title,
      dueDateISO,
      assignedTo: assignedTo || null,
      status,
      meta,
      createdBy: req.user.id
    });
    
    await task.save();
    
    // Populate assignedTo details
    if (assignedTo && assignedUser) {
      task.assignedTo = {
        id: assignedUser._id,
        email: assignedUser.email,
        name: assignedUser.name
      };
    }
    
    res.status(201).json({ 
      success: true, 
      task 
    });
    
  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({ 
      error: 'Failed to create task' 
    });
  }
};

// Get task board with filters (Admin only)
export const getTaskBoard = async (req, res) => {
  try {
    const { firmId } = req.user;
    
    // Check plan for feature restrictions
    const firm = await Firm.findById(firmId);
    const plan = firm?.subscription?.plan || 'FREE';
    
    // Base query - only tasks from this firm
    const query = { firmId };
    
    // Apply filters based on query params (Premium feature)
    const { serviceType, assignedTo, month } = req.query;
    
    if (serviceType && plan === 'PREMIUM') {
      query.serviceType = serviceType;
    }
    
    if (assignedTo && plan === 'PREMIUM') {
      query.assignedTo = assignedTo;
    }
    
    if (month && plan === 'PREMIUM') {
      const yearMonth = month; // format: YYYY-MM
      const [year, monthNum] = yearMonth.split('-').map(Number);
      const startDate = new Date(year, monthNum - 1, 1);
      const endDate = new Date(year, monthNum, 0, 23, 59, 59);
      
      query.dueDateISO = {
        $gte: startDate.toISOString(),
        $lte: endDate.toISOString()
      };
    }
    
    // Fetch all tasks for the firm with filters
    const tasks = await Task.find(query)
      .populate('assignedTo', 'email name')
      .sort({ dueDateISO: 1 });
    
    // Group by status
    const columns = {
      NOT_STARTED: [],
      WAITING_DOCS: [],
      IN_PROGRESS: [],
      FILED: [],
      CLOSED: []
    };
    
    tasks.forEach(task => {
      const status = task.status || 'NOT_STARTED';
      if (columns[status]) {
        columns[status].push({
          id: task._id,
          clientName: task.clientName,
          serviceType: task.serviceType,
          title: task.title,
          dueDateISO: task.dueDateISO,
          assignedTo: task.assignedTo,
          status: task.status,
          meta: task.meta || {}
        });
      }
    });
    
    res.json({ 
      columns,
      plan
    });
    
  } catch (error) {
    console.error('Get task board error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch task board' 
    });
  }
};

// Update a task (Admin only for status/assign, users can complete)
export const updateTask = async (req, res) => {
  try {
    const { firmId } = req.user;
    const { id } = req.params;
    const updates = req.body;
    
    const task = await Task.findOne({ 
      _id: id, 
      firmId 
    });
    
    if (!task) {
      return res.status(404).json({ 
        error: 'Task not found' 
      });
    }
    
    // Admin can update anything, users can only update specific fields
    const isAdmin = await canManageFirmTasks(req.user.id, firmId);
    
    if (!isAdmin) {
      // Users can only mark tasks as done if assigned to them
      const allowedFields = ['status'];
      const userUpdate = {};
      
      Object.keys(updates).forEach(key => {
        if (allowedFields.includes(key)) {
          userUpdate[key] = updates[key];
        }
      });
      
      // Only allow updating if task is assigned to this user
      if (task.assignedTo?.toString() !== req.user.id) {
        return res.status(403).json({ 
          error: 'You can only update tasks assigned to you' 
        });
      }
      
      // Only allow status change to CLOSED for users
      if (userUpdate.status && userUpdate.status !== 'CLOSED') {
        return res.status(403).json({ 
          error: 'You can only mark tasks as CLOSED' 
        });
      }
      
      Object.assign(task, userUpdate);
    } else {
      // Admin can update everything
      Object.assign(task, updates);
      
      // If assignedTo is being updated, verify the user belongs to the firm
      if (updates.assignedTo) {
        const assignedUser = await User.findOne({
          _id: updates.assignedTo,
          firmId
        });
        
        if (!assignedUser) {
          return res.status(400).json({ 
            error: 'Assigned user not found or does not belong to your firm' 
          });
        }
      }
    }
    
    await task.save();
    
    res.json({ 
      success: true, 
      task 
    });
    
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({ 
      error: 'Failed to update task' 
    });
  }
};

// Get my open tasks (for logged-in staff)
export const getMyOpenTasks = async (req, res) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.user;
    
    const openStatuses = ['NOT_STARTED', 'WAITING_DOCS', 'IN_PROGRESS'];
    
    const tasks = await Task.find({
      firmId,
      assignedTo: userId,
      status: { $in: openStatuses }
    })
    .populate('assignedTo', 'email name')
    .sort({ dueDateISO: 1 })
    .limit(50);
    
    res.json({ 
      success: true, 
      tasks 
    });
    
  } catch (error) {
    console.error('Get my open tasks error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch your tasks' 
    });
  }
};

// Mark task as done from user (Chrome extension)
export const completeTaskFromUser = async (req, res) => {
  try {
    const { firmId, id: userId } = req.user;
    const { id } = req.params;
    
    const task = await Task.findOne({ 
      _id: id, 
      firmId,
      assignedTo: userId 
    });
    
    if (!task) {
      return res.status(404).json({ 
        error: 'Task not found or not assigned to you' 
      });
    }
    
    // Only allow marking as CLOSED
    task.status = 'CLOSED';
    await task.save();
    
    res.json({ 
      success: true, 
      task 
    });
    
  } catch (error) {
    console.error('Complete task from user error:', error);
    res.status(500).json({ 
      error: 'Failed to complete task' 
    });
  }
};

// Record a follow-up action
export const postTaskFollowup = async (req, res) => {
  try {
    const { firmId } = req.user;
    const { id } = req.params;
    
    const task = await Task.findOne({ 
      _id: id, 
      firmId 
    });
    
    if (!task) {
      return res.status(404).json({ 
        error: 'Task not found' 
      });
    }
    
    // Update task with followup timestamp
    task.meta = task.meta || {};
    task.meta.lastFollowup = new Date().toISOString();
    task.meta.followupCount = (task.meta.followupCount || 0) + 1;
    
    await task.save();
    
    res.json({ 
      success: true, 
      task 
    });
    
  } catch (error) {
    console.error('Post task followup error:', error);
    res.status(500).json({ 
      error: 'Failed to record followup' 
    });
  }
};

// Escalate a task
export const postTaskEscalate = async (req, res) => {
  try {
    const { firmId } = req.user;
    const { id } = req.params;
    
    const task = await Task.findOne({ 
      _id: id, 
      firmId 
    });
    
    if (!task) {
      return res.status(404).json({ 
        error: 'Task not found' 
      });
    }
    
    // Mark task as escalated
    task.meta = task.meta || {};
    task.meta.escalated = true;
    task.meta.escalatedAt = new Date().toISOString();
    task.meta.escalatedBy = req.user.id;
    
    await task.save();
    
    res.json({ 
      success: true, 
      task 
    });
    
  } catch (error) {
    console.error('Post task escalate error:', error);
    res.status(500).json({ 
      error: 'Failed to escalate task' 
    });
  }
};

// Named exports for ES6 modules (added at bottom as requested)
export {
  createTask,
  getTaskBoard,
  updateTask,
  getMyOpenTasks,
  postTaskFollowup,
  postTaskEscalate
};