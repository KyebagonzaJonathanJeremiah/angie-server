import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { intersection } from 'lodash';
import { getRepository, ILike, In, Like, Repository } from 'typeorm';
import Contact from './entities/contact.entity';
import { CreatePersonDto } from './dto/create-person.dto';
import {
  createAvatar,
  getCellGroup,
  getEmail,
  getLocation,
  getPersonFullName,
  getPhone,
} from './crm.helpers';
import { ContactSearchDto } from './dto/contact-search.dto';
import { ContactCategory } from './enums/contactCategory';
import Phone from './entities/phone.entity';
import Email from './entities/email.entity';
import Person from './entities/person.entity';
import Company from './entities/company.entity';
import { CreateCompanyDto } from './dto/create-company.dto';
import { hasNoValue, hasValue, isValidNumber } from '../utils/basicHelpers';
import { PhoneCategory } from './enums/phoneCategory';
import { EmailCategory } from './enums/emailCategory';
import Address from './entities/address.entity';
import { AddressCategory } from './enums/addressCategory';
import GroupMembership from '../groups/entities/groupMembership.entity';
import { GroupRole } from '../groups/enums/groupRole';
import ContactListDto from './dto/contact-list.dto';
import { FindConditions } from 'typeorm/find-options/FindConditions';
import Group from '../groups/entities/group.entity';
import { GroupPrivacy } from '../groups/enums/groupPrivacy';
import { GoogleService } from 'src/vendor/google.service';
import GooglePlaceDto from 'src/vendor/google-place.dto';
import { getPreciseDistance } from 'geolib';
import GroupMembershipRequest from 'src/groups/entities/groupMembershipRequest.entity';
import { IEmail, sendEmail } from 'src/utils/mailerTest';
import {
  GetClosestGroupDto,
  GetGroupResponseDto,
} from 'src/groups/dto/membershipRequest/new-request.dto';

@Injectable()
export class ContactsService {
  constructor(
    @InjectRepository(Contact)
    private readonly repository: Repository<Contact>,
    @InjectRepository(Person)
    private readonly personRepository: Repository<Person>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(Phone)
    private readonly phoneRepository: Repository<Phone>,
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
    @InjectRepository(GroupMembership)
    private readonly membershipRepository: Repository<GroupMembership>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(GroupMembershipRequest)
    private readonly gmRequestRepository: Repository<GroupMembershipRequest>,
    private googleService: GoogleService,
  ) {}

  async findAll(req: ContactSearchDto): Promise<ContactListDto[]> {
    try {
      let hasFilter = false;
      //This will hold the query id list
      let idList: number[] = [];
      const groups = [
        ...(req.cellGroups || []),
        ...(req.churchLocations || []),
      ];
      if (hasValue(groups)) {
        Logger.log(`searching by groups: ${groups.join(',')}`);
        hasFilter = true;
        const resp = await this.membershipRepository.find({
          select: ['contactId'],
          where: { groupId: In(groups) },
        });
        if (hasValue(idList)) {
          idList = intersection(
            idList,
            resp.map(it => it.contactId),
          );
        } else {
          idList.push(...resp.map(it => it.contactId));
        }
      }

      if (hasValue(req.query)) {
        hasFilter = true;
        const resp = await this.personRepository.find({
          select: ['contactId'],
          where: [
            {
              firstName: ILike(`%${req.query.trim()}%`),
            },
            {
              lastName: ILike(`%${req.query.trim()}%`),
            },
            {
              middleName: ILike(`%${req.query.trim()}%`),
            },
          ],
        });
        if (hasValue(idList)) {
          idList = intersection(
            idList,
            resp.map(it => it.contactId),
          );
        } else {
          idList.push(...resp.map(it => it.contactId));
        }
      }

      if (hasValue(req.phone)) {
        hasFilter = true;
        const resp = await this.phoneRepository.find({
          select: ['contactId'],
          where: { value: Like(`%${req.phone}%`) },
        });
        console.log('resp', resp);
        if (hasValue(idList)) {
          idList = intersection(
            idList,
            resp.map(it => it.contactId),
          );
        } else {
          idList.push(...resp.map(it => it.contactId));
        }
      }

      if (hasValue(req.email)) {
        hasFilter = true;
        const resp = await this.emailRepository.find({
          select: ['contactId'],
          where: { value: ILike(`%${req.email.trim().toLowerCase()}%`) },
        });
        Logger.log(`searching by email: ${resp.join(',')}`);
        if (hasValue(idList)) {
          idList = intersection(
            idList,
            resp.map(it => it.contactId),
          );
        } else {
          idList.push(...resp.map(it => it.contactId));
        }
      }

      console.log('IdList', idList);
      if (hasFilter && hasNoValue(idList)) {
        return [];
      }
      const findOpts: FindConditions<Contact> = {};
      if (hasValue(idList)) {
        findOpts.id = In(idList);
      }
      const data = await this.repository.find({
        relations: [
          'person',
          'emails',
          'phones',
          'groupMemberships',
          'groupMemberships.group',
        ],
        skip: req.skip,
        take: req.limit,
        where: findOpts,
      });
      return data.map(it => {
        return ContactsService.toListDto(it);
      });
    } catch (e) {
      Logger.error(e.message);
      return [];
    }
  }

  public static toListDto(it: Contact): ContactListDto {
    const cellGroup = getCellGroup(it);
    const location = getLocation(it);
    return {
      id: it.id,
      name: getPersonFullName(it.person),
      avatar: it.person.avatar,
      ageGroup: it.person.ageGroup,
      dateOfBirth: it.person.dateOfBirth,
      email: getEmail(it),
      phone: getPhone(it),
      cellGroup: hasValue(cellGroup)
        ? { id: cellGroup.id, name: cellGroup.name }
        : null,
      location: hasValue(location)
        ? { id: location.id, name: location.name }
        : null,
    };
  }

  async create(data: Contact): Promise<Contact> {
    return await this.repository.save(data);
  }

  async update(data: Contact): Promise<Contact> {
    return await this.repository.save(data);
  }

  async createPerson(personDto: CreatePersonDto): Promise<Contact> {
    /*
     * TODO We can't save the contact at once because of a bug in type-orm
     *  https://github.com/typeorm/typeorm/issues/4090
     * */
    const person = new Person();
    person.firstName = personDto.firstName;
    person.middleName = personDto.middleName;
    person.lastName = personDto.lastName;
    person.civilStatus = personDto.civilStatus;
    person.salutation = null;
    person.dateOfBirth = personDto.dateOfBirth;
    person.avatar = createAvatar(personDto.email);
    person.gender = personDto.gender;
    person.placeOfWork = personDto.placeOfWork;
    person.ageGroup = personDto.ageGroup;

    const phones: Phone[] = [];
    if (hasValue(personDto.phone)) {
      const p = new Phone();
      p.category = PhoneCategory.Mobile;
      p.isPrimary = true;
      p.value = personDto.phone;
      phones.push(p);
    }

    const emails: Email[] = [];
    if (hasValue(personDto.email)) {
      const e = new Email();
      e.category = EmailCategory.Personal;
      e.isPrimary = true;
      e.value = personDto.email;
      emails.push(e);
    }

    const addresses: Address[] = [];
    if (hasValue(personDto.residence)) {
      const address = new Address();
      address.category = AddressCategory.Home;
      address.isPrimary = true;

      address.county = '-NA-';
      address.freeForm = personDto.residence.description;
      address.placeId = personDto.residence.place_id;
      //Make a call to the Google API to get coordinates
      let place: GooglePlaceDto = null;
      if (address.placeId) {
        place = await this.googleService.getPlaceDetails(address.placeId);
        address.longitude = place.longitude;
        address.latitude = place.latitude;
        address.country = place.country;
        address.district = place.district;
      }
      addresses.push(address);
    }

    const groupMemberships: GroupMembership[] = [];
    if (isValidNumber(personDto.churchLocationId)) {
      const membership = new GroupMembership();
      membership.groupId = personDto.churchLocationId;
      membership.role = GroupRole.Member;
      groupMemberships.push(membership);
    }
    const groupMembershipRequests: GroupMembershipRequest[] = [];
    if (personDto.inCell === 'Yes') {
      if (isValidNumber(personDto.cellGroupId)) {
        const membership = new GroupMembership();
        membership.groupId = personDto.cellGroupId;
        membership.role = GroupRole.Member;
        groupMemberships.push(membership);
      } else if (typeof personDto.cellGroupId === 'string') {
        const group = new Group();
        group.name = personDto.cellGroupId;
        group.parentId = personDto.churchLocationId;
        group.privacy = GroupPrivacy.Public;
        group.categoryId = 'MC';
        group.details = '--pending--';
        await this.groupRepository.save(group);
        const membership = new GroupMembership();
        membership.groupId = group.id;
        membership.role = GroupRole.Member;
        groupMemberships.push(membership);
      }
    } else {
      if (personDto.joinCell === 'Yes') {
        const groupRequest = new GroupMembershipRequest();

        const details = {
          placeId: personDto.residence.place_id,
          churchLocation: personDto.churchLocationId,
        };

        const closestGroup = await this.getClosestGroup(details);

        groupRequest.parentId = details.churchLocation;
        groupRequest.groupId = closestGroup.groupId;
        groupRequest.distanceKm = closestGroup.distance / 1000;
        groupMembershipRequests.push(groupRequest);

        //notify cell group leader of cell group with shortest distance to the person's residence
        const closestCellData = JSON.parse(closestGroup.groupMeta);
        const mailerData: IEmail = {
          to: `${closestCellData.email}`,
          subject: 'Join MC Request',
          html: `
          <h3>Hello ${closestCellData.leaders},</h3></br>
          <h4>I hope all is well on your end.<h4></br>
          <p>${personDto.firstName} ${personDto.lastName} who lives in ${personDto.residence.description},
          would like to join your Missional Community ${closestGroup.groupName}.</br>
          You can reach ${personDto.firstName} on ${personDto.phone} or ${personDto.email}.</p></br>
          <p>Cheers!</p>
          `,
        };
        await sendEmail(mailerData);
      }
    }

    const model = new Contact();
    model.category = ContactCategory.Person;
    const contact = await this.repository.save(model);
    const contactRef = Contact.ref(contact.id);
    contact.person = await this.personRepository.save({
      ...person,
      contact: contactRef,
    });
    contact.phones = await this.phoneRepository.save(
      phones.map(it => ({ ...it, contact: contactRef })),
    );
    contact.emails = await this.emailRepository.save(
      emails.map(it => ({ ...it, contact: contactRef })),
    );
    contact.addresses = await this.addressRepository.save(
      addresses.map(it => ({ ...it, contact: contactRef })),
    );
    contact.groupMemberships = await this.membershipRepository.save(
      groupMemberships.map(it => ({
        ...it,
        contact: contactRef,
      })),
    );
    contact.groupMembershipRequests = await this.gmRequestRepository.save(
      groupMembershipRequests.map(it => ({
        ...it,
        contact: contactRef,
      })),
    );
    contact.identifications = [];
    contact.occasions = [];
    return await this.findOne(contact.id);
  }

  async getClosestGroup(
    data: GetClosestGroupDto,
  ): Promise<any | GetGroupResponseDto> {
    try {
      const { placeId, churchLocation } = data;

      let place: GooglePlaceDto = null;
      if (placeId) {
        place = await this.googleService.getPlaceDetails(placeId);
      }

      const groupsAtLocation = await getRepository(Group)
        .createQueryBuilder('group')
        .where('group.parentId = :churchLocationId', {
          churchLocationId: churchLocation,
        })
        .andWhere("group.categoryId = 'MC'")
        .getMany();

      if (groupsAtLocation.length === 0) {
        Logger.warn("There are no groups in the person's vicinity");
        return [];
      }

      //Variable to store closest cell group
      let closestCellGroupid = groupsAtLocation[0].id;
      let closestCellGroupname = groupsAtLocation[0].name;
      let closestCellGroupMetadata = groupsAtLocation[0].metaData;
      //Initialise variable to store least distance
      let leastDistance = getPreciseDistance(
        { latitude: place.latitude, longitude: place.longitude },
        {
          latitude: groupsAtLocation[0].latitude,
          longitude: groupsAtLocation[0].longitude,
        },
        1,
      );

      //Calculate closest distance
      for (let i = 1; i < groupsAtLocation.length; i++) {
        const distanceToCellGroup = getPreciseDistance(
          { latitude: place.latitude, longitude: place.longitude },
          {
            latitude: groupsAtLocation[i].latitude,
            longitude: groupsAtLocation[i].longitude,
          },
          1,
        );
        if (distanceToCellGroup < leastDistance) {
          leastDistance = distanceToCellGroup;
          closestCellGroupid = groupsAtLocation[i].id;
          closestCellGroupname = groupsAtLocation[i].name;
          closestCellGroupMetadata = groupsAtLocation[i].metaData;
        }
      }
      return {
        groupId: closestCellGroupid,
        groupName: closestCellGroupname,
        groupMeta: closestCellGroupMetadata,
        distance: leastDistance,
      };
    } catch (e) {
      Logger.error('Failed to create member request', e);
      return [];
    }
  }

  async findOne(id: number): Promise<Contact> {
    return await this.repository.findOne(id, {
      relations: [
        'person',
        'emails',
        'phones',
        'addresses',
        'identifications',
        'requests',
        'relationships',
        'groupMemberships',
        'groupMemberships.group',
      ],
    });
  }

  async remove(id: number): Promise<void> {
    await this.repository.delete(id);
  }

  async findByName(username: string): Promise<Contact | undefined> {
    return await this.repository.findOne({
      where: { username },
      relations: ['contact.person'],
    });
  }

  async createCompany(data: CreateCompanyDto): Promise<Contact> {
    throw 'Not yet implemented';
  }
}
