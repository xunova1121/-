# Hosted runners use the mirror list in both deb822 and traditional apt entries.
s#mirror\+file:/+etc/apt/apt-mirrors[.]txt([[:space:]]|$)#https://archive.ubuntu.com/ubuntu/\1#g
s#https?://(azure|[a-z0-9-]+[.]ec2)[.]archive[.]ubuntu[.]com/ubuntu/?([[:space:]]|$)#https://archive.ubuntu.com/ubuntu/\2#g
