import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

// Background jobs run inside the request here, so a sent email is in the mailbox when the call returns.
// The RabbitMQ-backed queue has its own e2e suite.
process.env.JOB_QUEUE = 'inline';
