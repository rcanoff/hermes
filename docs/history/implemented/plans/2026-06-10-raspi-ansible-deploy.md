# Raspberry Pi Ansible Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Ansible deployment project that pushes this workspace from the local machine to `rcanoff@raspberrypi5.local:/home/rcanoff/hermes` with `rsync` over SSH and updates the remote Docker Compose stack in place.

**Architecture:** Keep the deployment project isolated under `ansible/`. Use Ansible for orchestration, `rsync` for diff-based transfer, and Linux-native remote commands for token sync and `docker compose up -d` on the Raspberry Pi.

**Tech Stack:** Ansible, YAML, rsync, SSH, Docker Compose

---

## File Structure

- Create: `ansible/ansible.cfg`
  - repo-local Ansible defaults
- Create: `ansible/inventory/hosts.yml`
  - inventory with the Raspberry Pi host
- Create: `ansible/inventory/group_vars/raspi.yml`
  - non-secret deployment variables for the Raspberry Pi target
- Create: `ansible/files/rsync-excludes.txt`
  - explicit exclude list for runtime and local-only files
- Create: `ansible/deploy.yml`
  - main deployment playbook
- Modify: `README.md`
  - document the Raspberry Pi deploy workflow
- Modify: `docs/history/implemented/specs/2026-06-10-raspi-ansible-deploy-design.md`
  - reflect the concrete host and path

## Task 1: Scaffold the Ansible Project

**Files:**
- Create: `ansible/ansible.cfg`
- Create: `ansible/inventory/hosts.yml`
- Create: `ansible/inventory/group_vars/raspi.yml`

- [ ] **Step 1: Create the Ansible config**

Create `ansible/ansible.cfg`:

```ini
[defaults]
inventory = inventory/hosts.yml
interpreter_python = auto_silent
host_key_checking = True
retry_files_enabled = False
stdout_callback = yaml
```

- [ ] **Step 2: Create the inventory**

Create `ansible/inventory/hosts.yml`:

```yaml
all:
  children:
    raspi:
      hosts:
        hermes_raspi:
          ansible_host: raspberrypi5.local
```

- [ ] **Step 3: Create the group variables**

Create `ansible/inventory/group_vars/raspi.yml`:

```yaml
ansible_user: rcanoff
remote_deploy_path: /home/rcanoff/hermes
compose_env_file: .env
compose_project_dir: /home/rcanoff/hermes
```

## Task 2: Add the Rsync Exclude Rules

**Files:**
- Create: `ansible/files/rsync-excludes.txt`

- [ ] **Step 1: Create the exclude list**

Create `ansible/files/rsync-excludes.txt`:

```text
.git/
.pnpm-store/
apple-caldav-mcp/node_modules/
apple-caldav-mcp/dist/
data/
v11/
hermes.zip
```

## Task 3: Implement the Deployment Playbook

**Files:**
- Create: `ansible/deploy.yml`

- [ ] **Step 1: Create the playbook**

Create `ansible/deploy.yml`:

```yaml
---
- name: Deploy Hermes workspace to Raspberry Pi
  hosts: raspi
  gather_facts: false
  vars:
    local_project_dir: "{{ playbook_dir | dirname }}"
    rsync_excludes_file: "{{ playbook_dir }}/files/rsync-excludes.txt"
    remote_compose_dir: "{{ compose_project_dir | default(remote_deploy_path) }}"
    remote_compose_cmd: docker compose --env-file {{ compose_env_file }} up -d
    remote_ps_cmd: docker compose ps

  pre_tasks:
    - name: Validate required deployment variables
      ansible.builtin.assert:
        that:
          - ansible_host is defined
          - ansible_user is defined
          - remote_deploy_path is defined
          - remote_deploy_path | length > 0
        fail_msg: Missing one of ansible_host, ansible_user, or remote_deploy_path.

    - name: Check local rsync availability
      ansible.builtin.command: rsync --version
      delegate_to: localhost
      changed_when: false

    - name: Check remote rsync availability
      ansible.builtin.command: rsync --version
      changed_when: false

    - name: Ensure remote deploy directory exists
      ansible.builtin.file:
        path: "{{ remote_deploy_path }}"
        state: directory
        mode: "0755"

  tasks:
    - name: Sync workspace to Raspberry Pi
      ansible.builtin.command:
        argv:
          - rsync
          - -az
          - --delete
          - --exclude-from={{ rsync_excludes_file }}
          - -e
          - ssh -p {{ ansible_port | default(22) }}
          - "{{ local_project_dir }}/"
          - "{{ ansible_user }}@{{ ansible_host }}:{{ remote_deploy_path }}/"
      delegate_to: localhost
      changed_when: true

    - name: Sync Apple Calendar MCP token on remote host
      ansible.builtin.command:
        argv:
          - sh
          - ./scripts/sync-apple-calendar-mcp-token.sh
          - "{{ compose_env_file }}"
          - data/config.yaml
      args:
        chdir: "{{ remote_compose_dir }}"

    - name: Start or update remote Hermes stack
      ansible.builtin.command:
        argv:
          - sh
          - -lc
          - "{{ remote_compose_cmd }}"
      args:
        chdir: "{{ remote_compose_dir }}"

    - name: Show remote compose status
      ansible.builtin.command:
        argv:
          - sh
          - -lc
          - "{{ remote_ps_cmd }}"
      args:
        chdir: "{{ remote_compose_dir }}"
      changed_when: false
      register: compose_ps

    - name: Print remote compose status
      ansible.builtin.debug:
        msg: "{{ compose_ps.stdout_lines }}"
```

## Task 4: Document the Operator Workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an Ansible deployment section**

Add a new `## Raspberry Pi deployment with Ansible` section to `README.md` that states:

```text
The repo includes an Ansible deployment project under `ansible/`.
It deploys this local workspace to `rcanoff@raspberrypi5.local:/home/rcanoff/hermes`
using `rsync` over SSH, then runs the remote Docker Compose update in place.
```

- [ ] **Step 2: Add the operator command**

Document this command in the new section:

```bash
ansible-playbook -i ansible/inventory/hosts.yml ansible/deploy.yml
```

- [ ] **Step 3: Document deployment behavior**

State explicitly that:

```text
- only changed files are pushed
- `data/` is excluded and remains remote runtime state
- `.env` is deployed from the local workspace
- the playbook runs `docker compose --env-file .env up -d` on the Pi
```

## Task 5: Verify the Ansible Project

**Files:**
- Modify: none

- [ ] **Step 1: Run inventory parsing**

Run:

```bash
ansible-inventory -i ansible/inventory/hosts.yml --list
```

Expected:

```text
Inventory renders successfully and includes the `raspi` group and `hermes_raspi` host.
```

- [ ] **Step 2: Run playbook syntax check**

Run:

```bash
ansible-playbook -i ansible/inventory/hosts.yml ansible/deploy.yml --syntax-check
```

Expected:

```text
Exit 0 and report that the playbook syntax is valid.
```

- [ ] **Step 3: If Ansible is available locally, run a dry inventory-limited ping**

Run:

```bash
ansible -i ansible/inventory/hosts.yml raspi -m ping
```

Expected:

```text
SSH connectivity succeeds or fails with a host-side connectivity error unrelated to playbook syntax.
```

## Self-Review

- Spec coverage: the plan covers local-to-Pi rsync deployment, remote directory preparation, remote compose update, and README documentation.
- Placeholder scan: no TBD sections or implied code steps are left blank.
- Type consistency: the plan uses `ansible_host`, `ansible_user`, `remote_deploy_path`, and `compose_env_file` consistently across inventory and playbook tasks.
