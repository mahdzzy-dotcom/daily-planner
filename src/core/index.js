'use strict';

module.exports = {
  ...require('./time'),
  ...require('./zones'),
  ...require('./layout'),
  ...require('./recurrence'),
  ...require('./tasks'),
  ...require('./reminders'),
  ...require('./reminder-engine'),
  ...require('./cities'),
  ...require('./settings'),
  ...require('./data'),
  ...require('./prayer-adapter'),
};
