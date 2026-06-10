SHELL := /bin/bash

ENV_FILE := $(if $(wildcard .env),.env,.env.example)
HOST_UID := $(shell id -u)
HOST_GID := $(shell id -g)
COMPOSE := HERMES_UID=$(HOST_UID) HERMES_GID=$(HOST_GID) docker compose --env-file $(ENV_FILE)
SYNC_APPLE_CALENDAR_MCP_TOKEN := ./scripts/sync-apple-calendar-mcp-token.sh "$(ENV_FILE)" data/config.yaml
IS_WSL := $(if $(WSL_DISTRO_NAME),1,)
WINDOWS_CWD := $(shell wslpath -w "$(CURDIR)" 2>/dev/null)
POWERSHELL_HERMES := powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location '$(WINDOWS_CWD)'; & '.\\scripts\\hermes.ps1'"
ANSIBLE_DIR := ansible
ANSIBLE := cd $(ANSIBLE_DIR) && ansible-playbook

.PHONY: help env config up down ps logs restart sync-apple-calendar-mcp-token deploy

help:
	@printf '%s\n' \
		'make up             Start Hermes gateway and dashboard' \
		'make down           Stop containers' \
		'make ps             Show container status' \
		'make logs           Show container logs' \
		'make config         Render merged compose config' \
		'make deploy         Deploy this workspace to the Raspberry Pi via Ansible' \
		'make sync-apple-calendar-mcp-token  Sync Apple Calendar MCP token into data/config.yaml' \
		'make env            Show the env file and UID/GID in use'

env:
	@printf 'ENV_FILE=%s\nHERMES_UID=%s\nHERMES_GID=%s\n' "$(ENV_FILE)" "$(HOST_UID)" "$(HOST_GID)"

sync-apple-calendar-mcp-token:
	@$(SYNC_APPLE_CALENDAR_MCP_TOKEN)

config:
ifeq ($(IS_WSL),1)
	@$(POWERSHELL_HERMES) config
else
	@$(SYNC_APPLE_CALENDAR_MCP_TOKEN)
	@$(COMPOSE) config
endif

up:
ifeq ($(IS_WSL),1)
	@$(POWERSHELL_HERMES) up
else
	@$(SYNC_APPLE_CALENDAR_MCP_TOKEN)
	@$(COMPOSE) up -d
endif

down:
ifeq ($(IS_WSL),1)
	@$(POWERSHELL_HERMES) down
else
	@$(COMPOSE) down
endif

ps:
ifeq ($(IS_WSL),1)
	@$(POWERSHELL_HERMES) ps
else
	@$(COMPOSE) ps
endif

logs:
ifeq ($(IS_WSL),1)
	@$(POWERSHELL_HERMES) logs
else
	@$(COMPOSE) logs --tail=150 hermes-gateway
endif

restart:
ifeq ($(IS_WSL),1)
	@$(POWERSHELL_HERMES) restart
else
	@$(COMPOSE) restart
endif

deploy:
	@$(ANSIBLE) deploy.yml
