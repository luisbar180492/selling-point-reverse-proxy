CREATE USER IF NOT EXISTS 'metabase'@'%' IDENTIFIED WITH mysql_native_password BY 'thepassword';

GRANT ALL PRIVILEGES ON selling_point_analytics.* TO 'metabase'@'%';

GRANT SELECT ON selling_point.* TO 'metabase'@'%';

-- Metabase uses the MariaDB connector to connect to MySQL servers.
-- The MariaDB connector lacks support for MySQL 8’s default authentication plugin.
-- In order to connect, you’ll need to change the plugin used by the Metabase user
ALTER USER 'metabase'@'%' IDENTIFIED WITH mysql_native_password BY 'thepassword';

FLUSH PRIVILEGES;
