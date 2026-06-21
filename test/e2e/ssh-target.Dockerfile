FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    file \
    openssh-client \
    openssh-server \
    procps \
    tmux \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/sshd /root/.ssh /state /work \
  && chmod 0700 /root/.ssh \
  && printf '%s\n' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'ChallengeResponseAuthentication no' \
    'PubkeyAuthentication yes' \
    'PermitRootLogin prohibit-password' \
    'StrictModes no' \
    'PrintMotd no' \
    > /etc/ssh/sshd_config.d/wux-e2e.conf

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
