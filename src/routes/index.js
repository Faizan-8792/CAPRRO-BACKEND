// ... other imports
import statsRoutes from './stats.routes.js';
import accountingRoutes from './accounting.routes.js';

// ... other routes
app.use('/api/stats', statsRoutes);
app.use('/api/accounting', accountingRoutes);