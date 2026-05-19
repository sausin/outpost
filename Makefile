.PHONY: install update backup restore logs status help

help:
	@echo "Outpost -- operator commands"
	@echo ""
	@echo "  make install              Run the interactive installer"
	@echo "  make update               Pull latest images and restart"
	@echo "  make backup               Snapshot Redis + config to ./backups/outpost-<ts>.tar.gz"
	@echo "  make restore BACKUP=path  Restore from a backup tarball"
	@echo "  make logs                 Tail proxy logs"
	@echo "  make status               Container status + health"

install:
	@./scripts/install.sh

update:
	@./scripts/update.sh

backup:
	@./scripts/backup.sh

restore:
	@test -n "$(BACKUP)" || (echo "Usage: make restore BACKUP=path/to/file.tar.gz" && exit 1)
	@./scripts/restore.sh $(BACKUP)

logs:
	@docker compose logs -f proxy

status:
	@./scripts/status.sh
