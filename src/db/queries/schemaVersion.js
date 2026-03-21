'use strict';

module.exports = {
  select: 'SELECT version FROM _schema_version',
  insert: 'INSERT INTO _schema_version (version) VALUES (0)',
  update: 'UPDATE _schema_version SET version = ?',
};
