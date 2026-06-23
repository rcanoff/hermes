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

.PHONY: help env config up down ps logs restart sync-apple-calendar-mcp-token deploy hermes-config hermes-config-edit hermes-setup hermes-model hermes-mcp-list hermes-gateway hermes-gateway-nosupervise hermes-shell messaging-api-logs messaging-api-shell browser-daemon-install browser-daemon-dev browser-daemon-start browser-daemon-stop browser-daemon-login-install browser-daemon-login-uninstall browser-daemon-login-status brave-google-start brave-google-sync brave-google-url brave-google-stop

help:
	@printf '%s\n' \
		'make up             Start Hermes gateway and dashboard' \
		'make down           Stop containers' \
		'make ps             Show container status' \
		'make logs           Show container logs' \
		'make config         Render merged compose config' \
		'make hermes-config  Open Hermes interactive config inside the container' \
		'make hermes-config-edit  Edit Hermes config file inside the container' \
		'make hermes-setup   Run Hermes setup inside the container' \
		'make hermes-model   Open Hermes model picker inside the container' \
		'make hermes-mcp-list  List configured Hermes MCP servers' \
		'make hermes-gateway Run `hermes gateway` inside the container' \
		'make hermes-gateway-nosupervise  Run gateway in foreground mode' \
		'make hermes-shell   Open a shell inside the Hermes container' \
		'make messaging-api-logs   Show messaging-api logs' \
		'make messaging-api-shell  Open a shell inside the messaging-api container' \
		'make deploy         Deploy this workspace to the Raspberry Pi via Ansible' \
		'make sync-apple-calendar-mcp-token  Sync Apple Calendar MCP token into data/config.yaml' \
		'make browser-daemon-install  Install browser-daemon dependencies' \
		'make browser-daemon-dev     Run browser-daemon on the Mac host (watch mode)' \
		'make browser-daemon-start  Start browser-daemon on the Mac host' \
		'make browser-daemon-stop   Stop browser-daemon on the Mac host' \
		'make browser-daemon-login-install   Install LaunchAgent (start at login)' \
		'make browser-daemon-login-uninstall Remove LaunchAgent' \
		'make browser-daemon-login-status    Show LaunchAgent status' \
		'make brave-google-start Launch Brave debug profile (optional manual CDP attach)' \
		'make brave-google-sync  Sync Brave CDP URL into Hermes config and restart' \
		'make brave-google-url   Print /browser connect command for the debug Brave session' \
		'make brave-google-stop  Stop the debug Brave session' \
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

hermes-config:
	@docker exec -it hermes hermes config

hermes-config-edit:
	@docker exec -it hermes hermes config edit

hermes-setup:
	@docker exec -it hermes hermes setup

hermes-model:
	@docker exec -it hermes hermes model

hermes-mcp-list:
	@docker exec -it hermes hermes mcp list

hermes-gateway:
	@docker exec -it hermes hermes gateway

hermes-gateway-nosupervise:
	@docker exec -it hermes hermes gateway run --no-supervise

hermes-shell:
	@docker exec -it hermes sh

messaging-api-logs:
	@$(COMPOSE) logs --tail=150 messaging-api

messaging-api-shell:
	@$(COMPOSE) exec messaging-api sh

deploy:
	@$(ANSIBLE) deploy.yml

browser-daemon-install:
	@cd browser-daemon && npm install

browser-daemon-dev:
	@cd browser-daemon && npm run dev

browser-daemon-start:
	@./scripts/browser-daemon.sh start

browser-daemon-stop:
	@./scripts/browser-daemon.sh stop

browser-daemon-login-install:
	@./scripts/browser-daemon-launchagent.sh install

browser-daemon-login-uninstall:
	@./scripts/browser-daemon-launchagent.sh uninstall

browser-daemon-login-status:
	@./scripts/browser-daemon-launchagent.sh status

brave-google-start:
	@./scripts/launch-brave-google.sh start

brave-google-sync:
	@./scripts/launch-brave-google.sh sync-config

brave-google-url:
	@./scripts/launch-brave-google.sh url

brave-google-stop:
	@./scripts/launch-brave-google.sh stop
