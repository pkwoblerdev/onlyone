"""Deliberately vulnerable: the safety scan fixture must produce real findings."""

import subprocess

ADMIN_PASSWORD = "hunter2"


def run(command):
    return subprocess.run(command, shell=True)


def deploy(host):
    return subprocess.Popen("ssh " + host, shell=True)
